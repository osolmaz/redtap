// redtap service worker: local capture store, unique-post export, and the
// Infinite Feed Scroller scrape bridge (xtap-scrape-v1 protocol).
console.log('[redtap-bg] fresh module load, manifest 0.2.0, ingest build');
import { canonical, observationId, postKey, postsFromApiPayload, recordFromApiPost, shouldSampleUnchanged } from './lib/observations.js';
import { admitRecords, flushNowNow, initPoolSync, setConfig, statusSnapshot } from './lib/pool-sync.js';
import { NetworkCapture } from './lib/network-capture.js';
import { CONTROL_ALARM, initControl } from './lib/control.js';

const EXPORT_BATCH_LIMIT = 5000;

// ---------------------------------------------------------------- storage

const store = {
  async get(key, fallback) {
    const bag = await chrome.storage.local.get(key);
    return key in bag ? bag[key] : fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

function subAllowed(subreddit) {
  const subs = (statusSnapshot().subs ?? ['LocalLLaMA']).map((s) => String(s).toLowerCase());
  if (typeof subreddit !== 'string' || subreddit === '') return true; // unknown source: let the store dedupe
  const bare = subreddit.replace(/^r\//i, '').toLowerCase();
  return subs.includes(bare);
}

async function recordObservation(record) {
  if (!record || !record.post_id) return null;
  if (!subAllowed(record.subreddit)) return null;
  const observation = { ...record, observation_id: await observationId(record) };
  const state = await store.get('redtapState', { samples: {}, exportedIds: [] });
  const samples = state.samples ?? {};
  const prior = samples[observation.post_id];
  if (prior && prior.observation_id === observation.observation_id) {
    if (!shouldSampleUnchanged(prior.lastSeenAtMs, Date.now())) return null;
  }
  // No local archive: the bucket's v2 log is the archive. Writing a growing
  // array here re-serialized megabytes per capture and wedged the worker.
  samples[observation.post_id] = {
    observation_id: observation.observation_id,
    lastSeenAtMs: Date.now(),
  };
  await store.set('redtapState', state);
  return observation;
}

// Local JSONL exports removed: the bucket's v2 log supersedes them.

// (see above)

// ------------------------------------------------------- scrape bridge (IFS)

const SCRAPE_PORT_NAME = 'xtap-scrape-v1';
const SCRAPE_PROTOCOL_VERSION = 1;
const SCROLLER_EXTENSION_ID = 'aahdialpkbjlbfjkpamfclbnlbinekal';

const runs = new Map();
const runPorts = new Map();

function toWire(run, records, nowMs) {
  return records.map((record) => ({
    cursor: (run.lastCursor += 1),
    knownBeforeRun: Boolean(record.knownBeforeRun),
    observedAtMs: nowMs,
    postAt: canonicalPostAt(record.post_at, nowMs),
    sourceEndpoint: record.source_endpoint || '/r/unknown',
    tweetId: record.post_id,
    captureSequence: run.nextCaptureSequence++,
    runId: run.runId,
    sourceTabId: run.sourceTabId,
  }));
}

function sendObservations(port, run, records) {
  const nowMs = Date.now();
  port.postMessage({ type: 'scrape:observations', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: run.runId, observations: toWire(run, records, nowMs) });
}

async function bridgeLog(entry) {
  console.log('[redtap-bridge]', JSON.stringify(entry));
  try {
    const log = (await store.get('bridgeLog', []));
    log.push({ at: Date.now(), ...entry });
    await store.set('bridgeLog', log.slice(-50));
  } catch {}
}

function createRun(message) {
  return {
    runId: message.runId,
    sourceTabId: message.sourceTabId,
    listId: message.listId,
    afterCursor: message.afterCursor ?? 0,
    lastCursor: message.afterCursor ?? 0,
    baselineSequence: 0,
    knownListCount: 0,
    nextCaptureSequence: 1,
    startedAtMs: message.startedAtMs ?? Date.now(),
    state: 'running',
    updatedAtMs: Date.now(),
    pending: [],
  };
}

function respondRun(run) {
  return { ...run, leaseExpiresAtMs: Date.now() + 60_000, protocolVersion: SCRAPE_PROTOCOL_VERSION, pending: undefined };
}

// ------------------------------------------------------------ run persistence

// The MV3 service worker idles out within seconds and the runs map dies with
// it; the scroller then reconnects and a fresh run would reset the cursor,
// making the client drop every redelivered observation. Persist runs and
// restore them on re-open so cursors and pending queues survive restarts.
const RUNS_KEY = 'bridgeRuns';

function persistRuns() {
  const payload = [...runs.values()].map((run) => ({ ...run, pending: run.pending.slice(-500) }));
  void store.set(RUNS_KEY, payload).catch((error) => {
    void swLog({ event: 'runs-persist-failed', error: String(error).slice(0, 120) });
  });
}

async function openRun(message) {
  const existing = runs.get(message.runId);
  if (existing) return existing;
  const stored = await store.get(RUNS_KEY, []);
  const saved = (Array.isArray(stored) ? stored : []).find((run) => run?.runId === message.runId);
  const run = saved ?? createRun(message);
  run.restored = saved !== undefined;
  run.openedAtMs = Date.now();
  run.state = 'running';
  run.updatedAtMs = Date.now();
  runs.set(run.runId, run);
  persistRuns();
  return run;
}

// -------------------------------------------------------- bridge counters

let captureMessages = 0;
let sessionBadgeCount = 0;
let poolSyncHealthy = true;

// --- badge (xtap parity, reddit colors) ---

function updateBadge() {
  if (!poolSyncHealthy) {
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#E0245E' });
    return;
  }
  void chrome.action.setBadgeText({ text: sessionBadgeCount > 0 ? String(sessionBadgeCount) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#FF4500' });
}

function refreshSyncHealth() {
  const snap = statusSnapshot();
  poolSyncHealthy = !snap.configured || snap.lastError === null;
  updateBadge();
}
setInterval(refreshSyncHealth, 30_000);
let capturesStored = 0;
let pollRequests = 0;
let pendingPushed = 0;

// Drain the run's pending captures into a wire-shaped observations reply.
// postAt must be canonical UTC (Z-form) or the client drops the whole batch;
// reddit ships +00:00 offsets, so normalize everything through Date.
function canonicalPostAt(value, fallbackMs) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(fallbackMs).toISOString();
}

function observationsReply(run) {
  const drained = run.pending.splice(0);
  run.drainCount = (run.drainCount ?? 0) + 1;
  run.lastCursorAtMs = Date.now();
  persistRuns();
  const nowMs = Date.now();
  return { type: 'scrape:observations', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: run.runId, observations: toWire(run, drained, nowMs) };
}

function runsSnapshot() {
  return [...runs.values()].map((run) => ({
    runId: run.runId.slice(0, 8),
    state: run.state,
    pending: run.pending.length,
    lastCursor: run.lastCursor,
    bound: runPorts.has(run.runId),
    drains: run.drainCount ?? 0,
    openedAtMs: run.openedAtMs ?? null,
    restored: run.restored ?? false,
  }));
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender?.id !== SCROLLER_EXTENSION_ID) {
    void bridgeLog({ event: 'reject-sender-msg', sender: sender?.id });
    sendResponse({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message?.runId ?? '', errorCode: 'invalid-request', error: 'unrecognized sender' });
    return;
  }
  if (!message || message.protocolVersion !== SCRAPE_PROTOCOL_VERSION) {
    sendResponse({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message?.runId ?? '', errorCode: 'invalid-request', error: 'unsupported protocol version' });
    return;
  }
  if (message.type === 'scrape:poll') {
    pollRequests += 1;
    const run = runs.get(message.runId);
    if (!run) {
      sendResponse({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, errorCode: 'unknown-run', error: 'unknown run' });
      return;
    }
    run.updatedAtMs = Date.now();
    sendResponse(observationsReply(run));
    return;
  }
  if (message.type === 'scrape:open') {
    void bridgeLog({ event: 'msg-open', runId: message.runId });
    void (async () => {
      const run = await openRun(message);
      sendResponse({
        type: 'scrape:opened',
        protocolVersion: SCRAPE_PROTOCOL_VERSION,
        runId: run.runId,
        run: respondRun(run),
        capabilities: ['search-timeline-observations', 'typed-errors', 'run-leases'],
        observations: [],
      });
    })();
    return true;
  }
  if (message.type === 'scrape:finish') {
    const run = runs.get(message.runId);
    if (run) run.state = message.state ?? 'completed';
    sendResponse({ type: 'scrape:finished', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, run: run ? respondRun(run) : undefined });
    runs.delete(message.runId);
    persistRuns();
    return;
  }
  return false;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  void bridgeLog({ event: 'connect', name: port.name, sender: port.sender?.id, senderUrl: port.sender?.url?.slice(0, 60) });
  if (port.name !== SCRAPE_PORT_NAME) {
    void bridgeLog({ event: 'reject-name', name: port.name });
    return;
  }
  if (port.sender?.id !== SCROLLER_EXTENSION_ID) {
    void bridgeLog({ event: 'reject-sender', sender: port.sender?.id });
    port.disconnect();
    return;
  }
  port.onMessage.addListener((message) => {
    void bridgeLog({ event: 'message', type: message?.type, pv: message?.protocolVersion });
    if (!message || message.protocolVersion !== SCRAPE_PROTOCOL_VERSION) {
      port.postMessage({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message?.runId ?? '', errorCode: 'invalid-request', error: 'unsupported protocol version' });
      return;
    }
    if (message.type === 'scrape:open') {
      void (async () => {
        const run = await openRun(message);
        runPorts.set(run.runId, port);
        try {
          port.postMessage({
            type: 'scrape:opened',
            protocolVersion: SCRAPE_PROTOCOL_VERSION,
            runId: run.runId,
            run: respondRun(run),
            capabilities: ['search-timeline-observations', 'typed-errors', 'run-leases'],
            observations: [],
          });
          void bridgeLog({ event: 'reply-sent', runId: run.runId });
        } catch (err) {
          void bridgeLog({ event: 'reply-failed', runId: run.runId, error: String(err).slice(0, 120) });
        }
      })();
      return;
    }
    if (message.type === 'scrape:poll') {
      pollRequests += 1;
      const run = runs.get(message.runId);
      if (!run) {
        port.postMessage({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, errorCode: 'unknown-run', error: 'unknown run' });
        return;
      }
      run.updatedAtMs = Date.now();
      port.postMessage(observationsReply(run));
      return;
    }
    if (message.type === 'scrape:heartbeat') {
      const run = runs.get(message.runId);
      if (run) run.updatedAtMs = message.renewedAtMs ?? Date.now();
      return;
    }
    if (message.type === 'scrape:finish') {
      const run = runs.get(message.runId);
      if (run) run.state = message.state ?? 'completed';
      port.postMessage({ type: 'scrape:finished', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, run });
      runs.delete(message.runId);
      runPorts.delete(message.runId);
      persistRuns();
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [runId, boundPort] of runPorts) {
      if (boundPort === port) {
        runPorts.delete(runId);
        runs.delete(runId);
        persistRuns();
      }
    }
  });
});

// ------------------------------------------------------------ message wiring

async function swLog(entry) {
  try {
    const log = (await store.get('swLog', []));
    log.push({ at: Date.now(), ...entry });
    await store.set('swLog', log.slice(-80));
  } catch {}
}

void (async () => {
  await swLog({ event: 'sw-start' });
  try {
    await initPoolSync({ log: swLog });
    await swLog({ event: 'pool-sync-init-ok' });
  } catch (error) {
    await swLog({ event: 'pool-sync-init-failed', error: String(error?.message ?? error).slice(0, 150) });
  }
  // No boot-time body backfill from a local archive: the archive is gone and
  // the bucket owns committed history. Fresh captures enrich as they arrive.
  await swLog({ event: 'boot-ready' });
})();

initControl({
  getConfig: async () => {
    const bag = await chrome.storage.local.get(['bucketRepo', 'hubToken']);
    return { bucketRepo: bag.bucketRepo ?? 'osolmaz/redtap-data', hubToken: bag.hubToken ?? '' };
  },
  heartbeat: async () => {
    const wall = await probeWall();
    const [logBag, bridgeLogTail] = await Promise.all([
      chrome.storage.local.get('swLog'),
      store.get('bridgeLog', []),
    ]);
    const snapshot = statusSnapshot();
    return {
      lines: snapshot.queued,
      selftextLines: snapshot.synced,
      swLog: (logBag.swLog ?? []).slice(-8),
      bridgeLog: (bridgeLogTail ?? []).slice(-10),
      bodyQueue: bodyQueue.length,
      bodyFailed: bodyFailed.size,
      runs: runsSnapshot(),
      captureMessages,
      capturesStored,
      pollRequests,
      pendingPushed,
      wall,
    };
  },
});

// Every observation source funnels through here: the records join each open
// scrape run's pending queue and any bound port receives them immediately.
function feedBridge(stored) {
  if (stored.length === 0) return;
  for (const run of runs.values()) {
    run.pending.push(...stored);
    pendingPushed += stored.length;
  }
  persistRuns();
  for (const [runId, port] of runPorts) {
    const run = runs.get(runId);
    if (!run || run.pending.length === 0) continue;
    const drained = run.pending.splice(0);
    sendObservations(port, run, drained);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'redtap:capture') return;
  (async () => {
    captureMessages += 1;
    const stored = [];
    for (const record of message.records ?? []) {
      const observation = await recordObservation(record);
      if (observation) stored.push(observation);
    }
    capturesStored += stored.length;
    feedBridge(stored);
    admitRecords(stored);
    enqueueBodyFetch(stored);
    sessionBadgeCount += stored.length;
    updateBadge();
    sendResponse({ stored: stored.length });
  })();
  return true;
});

// ------------------------------------------------------------ network tap

function handleTappedResponse({ data, url }) {
  void (async () => {
    const records = postsFromTapPayload(data);
    if (records.length === 0) return;
    const stored = [];
    for (const record of records) {
      const observation = await recordObservation(record);
      if (observation) stored.push(observation);
    }
    if (stored.length === 0) return;
    feedBridge(stored);
    admitRecords(stored);
    enqueueBodyFetch(stored);
    sessionBadgeCount += stored.length;
    updateBadge();
    void swLog({ event: 'tap-capture', count: stored.length, url: String(url).slice(0, 120) });
  })();
}

function postsFromTapPayload(payload) {
  return postsFromApiPayload(payload, { capturedAtMs: Date.now() });
}

const networkCapture = new NetworkCapture({ onResponse: handleTappedResponse });
networkCapture.attach();

// --------------------------------------------------- listing backfill pages

// The feed tab cannot page past reddit's logged-out cap (~500 posts), so a
// month of a busy subreddit never fits through scrolling alone. Page the
// public listing .json API directly: it supports `after` cursors, works
// logged out, and each response carries full post data (created time, body,
// score) through the same capture path as the network tap.

const LISTING_DELAY_MS = 2500;
const REDDIT_FETCH_GAP_MS = 3000;
const listingState = { lastAtMs: null, lastPages: 0, lastTotal: 0, running: false };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One rate gate for every reddit .json fetch: the listing paginator and the
// body enrichment share reddit's per-IP budget, so uncoordinated bursts
// from either get the whole worker rate-limited.
let redditFetchChain = Promise.resolve();

function redditFetch(url) {
  const run = redditFetchChain.then(() => fetch(url, { credentials: 'include' }));
  const release = run.catch(() => {}).then(() => sleep(REDDIT_FETCH_GAP_MS));
  redditFetchChain = release;
  return run;
}

async function paginateListing(path, params, { maxPages = 15 } = {}) {
  let after = '';
  let pages = 0;
  let total = 0;
  let retries = 0;
  while (pages < maxPages) {
    const query = new URLSearchParams({ limit: '100', raw_json: '1', ...params });
    if (after) query.set('after', after);
    const response = await fetch('https://www.reddit.com' + path + '?' + query, { credentials: 'include' });
    if (response.status === 429) {
      if (retries >= 3) throw new Error('listing rate-limited after retries');
      retries += 1;
      void swLog({ event: 'listing-429', page: pages + 1, retry: retries });
      await sleep(60_000);
      continue;
    }
    retries = 0;
    if (response.status === 403 || response.status === 404) throw new Error('listing responded ' + response.status);
    if (!response.ok) throw new Error('listing responded ' + response.status);
    const payload = await response.json();
    const records = postsFromApiPayload(payload, { capturedAtMs: Date.now() });
    if (records.length === 0) break;
    const stored = [];
    for (const record of records) {
      const observation = await recordObservation(record);
      if (observation) stored.push(observation);
    }
    feedBridge(stored);
    admitRecords(stored);
    enqueueBodyFetch(stored);
    pages += 1;
    total += stored.length;
    void swLog({ event: 'listing-page', path, page: pages, stored: stored.length });
    after = payload?.data?.after ?? '';
    if (!after) break;
    await sleep(REDDIT_FETCH_GAP_MS);
  }
  return { pages, total };
}

async function runListingBackfill() {
  if (listingState.running) return;
  listingState.running = true;
  // The paginator fetches directly at its own pace while the body queue is
  // paused: queued body fetches ahead of a listing page would idle the
  // worker past MV3's 30s kill and abort the pagination mid-run.
  bodyQueuePaused = true;
  try {
    const sub = (statusSnapshot().subs ?? ['LocalLLaMA'])[0] ?? 'LocalLLaMA';
    const month = await paginateListing('/r/' + sub + '/top/.json', { t: 'month' }, { maxPages: 15 });
    const fresh = await paginateListing('/r/' + sub + '/new/.json', {}, { maxPages: 5 });
    listingState.lastAtMs = Date.now();
    listingState.lastPages = month.pages + fresh.pages;
    listingState.lastTotal = month.total + fresh.total;
    void swLog({ event: 'listing-backfill', month: month.total, fresh: fresh.total });
  } catch (error) {
    void swLog({ event: 'listing-backfill-failed', error: String(error?.message ?? error).slice(0, 120) });
  } finally {
    bodyQueuePaused = false;
    listingState.running = false;
  }
}

const LISTING_ALARM = 'redtap-listing-backfill';
chrome.alarms.create(LISTING_ALARM, { periodInMinutes: 120, delayInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LISTING_ALARM) void runListingBackfill();
});

// ------------------------------------------------------- body enrichment

const BODY_FETCH_DELAY_MS = 1500;
const BODY_QUEUE_MAX = 500;
const bodyQueue = [];
const bodyFailed = new Set();
let bodyBusy = false;
let bodyQueuePaused = false;
let bodyTimer = null;

function enqueueBodyFetch(records) {
  let added = false;
  for (const record of records) {
    if (!record?.post_id || !record?.permalink || record.selftext) continue;
    if (bodyFailed.has(record.post_id)) continue;
    if (bodyQueue.some((item) => item.post_id === record.post_id)) continue;
    if (bodyQueue.length >= BODY_QUEUE_MAX) break;
    bodyQueue.push({ post_id: record.post_id, permalink: record.permalink });
    added = true;
  }
  if (added && !bodyBusy && bodyTimer === null) {
    bodyTimer = setTimeout(() => {
      bodyTimer = null;
      void drainBodyQueue();
    }, 2000);
  }
}

async function drainBodyQueue() {
  if (bodyBusy) return;
  bodyBusy = true;
  try {
    while (bodyQueue.length > 0) {
      if (bodyQueuePaused) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const item = bodyQueue.shift();
      await fetchPostBody(item);
      await new Promise((resolve) => setTimeout(resolve, BODY_FETCH_DELAY_MS));
    }
  } finally {
    bodyBusy = false;
  }
}

async function fetchPostBody(item) {
  const url = 'https://www.reddit.com' + item.permalink.replace(/\/+$/, '') + '.json?limit=50&raw_json=1';
  try {
    const response = await redditFetch(url);
    if (response.status === 429) {
      bodyQueue.unshift(item);
      return;
    }
    if (response.status === 403 || response.status === 404) {
      bodyFailed.add(item.post_id);
      void swLog({ event: 'body-fetch-gone', post_id: item.post_id, status: response.status });
      return;
    }
    if (!response.ok) throw new Error('api responded ' + response.status);
    const payload = await response.json();
    const entry = payload?.[0]?.data?.children?.find((child) => child?.kind === 't3')?.data;
    const record = recordFromApiPost(entry, { capturedAtMs: Date.now(), sourceEndpoint: '/api/enrich' });
    if (!record || !record.selftext) {
      bodyFailed.add(item.post_id);
      return;
    }
    const observation = await recordObservation(record);
    if (observation) {
      feedBridge([observation]);
      admitRecords([observation]);
    }
    void swLog({ event: 'body-enriched', post_id: item.post_id });
  } catch (error) {
    void swLog({ event: 'body-fetch-failed', post_id: item.post_id, error: String(error?.message ?? error).slice(0, 120) });
  }
}

// One-shot DOM probe of the attached feed tab: how is reddit's logged-out
// join wall actually dismissable? Reported through the telemetry heartbeat.
async function probeWall() {
  try {
    const targets = await new Promise((resolve, reject) => {
      chrome.debugger.getTargets((t) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t ?? []);
      });
    });
    const tab = targets.find((t) => t.attached && t.tabId !== undefined && /reddit\.com/.test(t.url ?? ''));
    if (!tab) return { attached: false };
    const reply = await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'Runtime.evaluate', {
      returnByValue: true,
      expression: `(async () => {
        const visible = (el) => el.checkVisibility?.() === true;
        const closeBtns = [...document.querySelectorAll('button')]
          .filter((b) => visible(b) && /close|dismiss/i.test((b.getAttribute('aria-label') ?? '') + ' ' + (b.getAttribute('title') ?? '')))
          .map((b) => ({ label: b.getAttribute('aria-label'), title: b.getAttribute('title'), html: b.outerHTML.slice(0, 140) }));
        const modal = [...document.querySelectorAll('div, section')]
          .filter((d) => visible(d) && d.textContent?.includes('Join the most real place'))
          .sort((a, b) => a.querySelectorAll('div').length - b.querySelectorAll('div').length)[0];
        let me = null;
        try {
          const r = await fetch('https://www.reddit.com/api/me.json', { credentials: 'include' });
          me = r.status === 200 ? ((await r.json())?.data?.name ?? 'ok') : 'http ' + r.status;
        } catch (e) { me = 'err'; }
        return JSON.stringify({
          url: location.pathname,
          me,
          posts: document.querySelectorAll('shreddit-post').length,
          closeBtns: closeBtns.slice(0, 5),
          modalButtons: modal ? [...modal.querySelectorAll('button')].slice(0, 10).map((b) => ({ label: b.getAttribute('aria-label'), text: b.textContent?.trim().slice(0, 30), visible: visible(b) })) : null,
        });
      })()`,
      awaitPromise: true,
    });
    return { attached: true, raw: reply?.result?.value };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 140) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'redtap:pool-config') {
    setConfig(message.config ?? {}, message.flushNow === true);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'redtap:pool-status') {
    void chrome.storage.local.get('swLog').then((bag) => {
      sendResponse({
        ...statusSnapshot(),
        listing: { ...listingState },
        captureMessages,
        capturesStored,
        swLog: (bag.swLog ?? []).slice(-6),
      });
    });
    return true;
  }
  if (message?.type === 'redtap:listing-backfill-now') {
    void runListingBackfill().then(() => sendResponse({ ok: true, listing: { ...listingState } }));
    return true;
  }
  if (message?.type === 'redtap:pool-flush-now') {
    flushNowNow().then((n) => sendResponse({ flushed: n }));
    return true;
  }
  if (message?.type !== 'redtap:export') return;
  // Local exports are gone; the bucket's v2 log is the data path.
  sendResponse({ exported: 0 });
  return true;
});
