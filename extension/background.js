// redtap service worker: local capture store, unique-post export, and the
// Infinite Feed Scroller scrape bridge (xtap-scrape-v1 protocol).
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

async function recordObservation(record) {
  if (!record || !record.post_id) return null;
  const observation = { ...record, observation_id: await observationId(record) };
  const state = await store.get('redtapState', { samples: {}, exportedIds: [] });
  const samples = state.samples ?? {};
  const prior = samples[observation.post_id];
  if (prior && prior.observation_id === observation.observation_id) {
    if (!shouldSampleUnchanged(prior.lastSeenAtMs, Date.now())) return null;
  }
  const lines = (await store.get('redtapLines', []));
  lines.push(observation);
  await store.set('redtapLines', lines);
  samples[observation.post_id] = {
    observation_id: observation.observation_id,
    lastSeenAtMs: Date.now(),
  };
  await store.set('redtapState', state);
  return observation;
}

async function exportAllJsonl() {
  const lines = await store.get('redtapLines', []);
  const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/x-ndjson' }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await chrome.downloads.download({ url, filename: `redtap/redtap-observations-${stamp}.jsonl` });
  return lines.length;
}

async function exportJsonl() {
  const lines = await store.get('redtapLines', []);
  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = postKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  const payload = unique.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/x-ndjson' }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await chrome.downloads.download({ url, filename: `redtap/redtap-${stamp}.jsonl` });
  return unique.length;
}

// ------------------------------------------------------- scrape bridge (IFS)

const SCRAPE_PORT_NAME = 'xtap-scrape-v1';
const SCRAPE_PROTOCOL_VERSION = 1;
const SCROLLER_EXTENSION_ID = 'aahdialpkbjlbfjkpamfclbnlbinekal';

const runs = new Map();
const runPorts = new Map();

function sendObservations(port, run, records) {
  void records;
  port.postMessage(observationsReply(run));
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
  run.state = 'running';
  run.updatedAtMs = Date.now();
  runs.set(run.runId, run);
  persistRuns();
  return run;
}

// -------------------------------------------------------- bridge counters

let captureMessages = 0;
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
  persistRuns();
  const nowMs = Date.now();
  const observations = drained.map((record) => ({
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
  return { type: 'scrape:observations', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: run.runId, observations };
}

function runsSnapshot() {
  return [...runs.values()].map((run) => ({
    runId: run.runId.slice(0, 8),
    state: run.state,
    pending: run.pending.length,
    lastCursor: run.lastCursor,
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
    await initPoolSync();
    await swLog({ event: 'pool-sync-init-ok' });
  } catch (error) {
    await swLog({ event: 'pool-sync-init-failed', error: String(error?.message ?? error).slice(0, 150) });
  }
  try {
    const lines = await store.get('redtapLines', []);
    const latest = new Map();
    for (const line of lines) {
      if (!line?.post_id) continue;
      latest.set(line.post_id, line);
    }
    const bodyless = [...latest.values()]
      .filter((record) => !record.selftext && record.permalink)
      .map((record) => ({ post_id: record.post_id, permalink: record.permalink }));
    enqueueBodyFetch(bodyless);
    await swLog({ event: 'boot-body-enrich', count: bodyless.length });
  } catch {}
})();

initControl({
  getConfig: async () => {
    const bag = await chrome.storage.local.get(['poolUrl', 'poolToken']);
    return { poolUrl: bag.poolUrl ?? '', poolToken: bag.poolToken ?? '' };
  },
  heartbeat: async () => {
    const [logBag, lines, bridgeLogTail] = await Promise.all([
      chrome.storage.local.get('swLog'),
      store.get('redtapLines', []),
      store.get('bridgeLog', []),
    ]);
    return {
      lines: lines.length,
      selftextLines: lines.filter((line) => line.selftext).length,
      swLog: (logBag.swLog ?? []).slice(-8),
      bridgeLog: (bridgeLogTail ?? []).slice(-10),
      bodyQueue: bodyQueue.length,
      bodyFailed: bodyFailed.size,
      runs: runsSnapshot(),
      captureMessages,
      capturesStored,
      pollRequests,
      pendingPushed,
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
    void swLog({ event: 'tap-capture', count: stored.length, url: String(url).slice(0, 120) });
  })();
}

function postsFromTapPayload(payload) {
  return postsFromApiPayload(payload, { capturedAtMs: Date.now() });
}

const networkCapture = new NetworkCapture({ onResponse: handleTappedResponse });
networkCapture.attach();

// ------------------------------------------------------- body enrichment

const BODY_FETCH_DELAY_MS = 1500;
const BODY_QUEUE_MAX = 500;
const bodyQueue = [];
const bodyFailed = new Set();
let bodyBusy = false;
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
    const response = await fetch(url, { credentials: 'include' });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'redtap:pool-config') {
    setConfig(message.config ?? {}, message.flushNow === true);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === 'redtap:pool-status') {
    sendResponse(statusSnapshot());
    return;
  }
  if (message?.type === 'redtap:pool-flush-now') {
    flushNowNow().then((n) => sendResponse({ flushed: n }));
    return true;
  }
  if (message?.type !== 'redtap:export') return;
  const uniqueOnly = message.uniqueOnly !== false;
  if (uniqueOnly) {
    exportJsonl().then((count) => sendResponse({ exported: count }));
  } else {
    exportAllJsonl().then((count) => sendResponse({ exported: count }));
  }
  return true;
});
