// redtap service worker: local capture store, unique-post export, and the
// Infinite Feed Scroller scrape bridge (xtap-scrape-v1 protocol).
import { canonical, observationId, postKey, postsFromApiPayload, recordFromApiPost, shouldSampleUnchanged } from './lib/observations.js';
import { admitRecords, flushNowNow, initPoolSync, setConfig, statusSnapshot } from './lib/pool-sync.js';
import { NetworkCapture } from './lib/network-capture.js';

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
  const observations = records.map((record, index) => ({
    cursor: (run.lastCursor += 1),
    knownBeforeRun: Boolean(record.knownBeforeRun),
    observedAtMs: Date.now(),
    postAt: record.post_at ?? '',
    sourceEndpoint: record.source_endpoint ?? '',
    tweetId: record.post_id,
    captureSequence: run.nextCaptureSequence++,
    runId: run.runId,
    sourceTabId: run.sourceTabId,
  }));
  port.postMessage({ type: 'scrape:observations', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: run.runId, observations });
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
  if (message.type === 'scrape:open') {
    void bridgeLog({ event: 'msg-open', runId: message.runId });
    const run = createRun(message);
    runs.set(message.runId, run);
    sendResponse({
      type: 'scrape:opened',
      protocolVersion: SCRAPE_PROTOCOL_VERSION,
      runId: run.runId,
      run: respondRun(run),
      capabilities: ['search-timeline-observations', 'typed-errors', 'run-leases'],
      observations: [],
    });
    return;
  }
  if (message.type === 'scrape:poll') {
    const run = runs.get(message.runId);
    if (!run) {
      sendResponse({ type: 'scrape:error', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, errorCode: 'unknown-run', error: 'unknown run' });
      return;
    }
    run.updatedAtMs = Date.now();
    const drained = run.pending.splice(0);
    const observations = drained.map((record) => ({
      cursor: (run.lastCursor += 1),
      knownBeforeRun: Boolean(record.knownBeforeRun),
      observedAtMs: Date.now(),
      postAt: record.post_at ?? '',
      sourceEndpoint: record.source_endpoint ?? '',
      tweetId: record.post_id,
      captureSequence: run.nextCaptureSequence++,
      runId: run.runId,
      sourceTabId: run.sourceTabId,
    }));
    sendResponse({ type: 'scrape:observations', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: run.runId, observations });
    return;
  }
  if (message.type === 'scrape:finish') {
    const run = runs.get(message.runId);
    if (run) run.state = message.state ?? 'completed';
    sendResponse({ type: 'scrape:finished', protocolVersion: SCRAPE_PROTOCOL_VERSION, runId: message.runId, run: run ? respondRun(run) : undefined });
    runs.delete(message.runId);
    return;
  }
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
      const run = createRun(message);
      runs.set(message.runId, run);
      runPorts.set(message.runId, port);
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
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [runId, boundPort] of runPorts) {
      if (boundPort === port) {
        runPorts.delete(runId);
        runs.delete(runId);
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
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'redtap:capture') return;
  (async () => {
    const stored = [];
    for (const record of message.records ?? []) {
      const observation = await recordObservation(record);
      if (observation) stored.push(observation);
    }
    for (const run of runs.values()) {
      if (stored.length > 0) run.pending.push(...stored);
    }
    for (const [runId, port] of runPorts) {
      const run = runs.get(runId);
      if (!run || run.pending.length === 0) continue;
      const drained = run.pending.splice(0);
      sendObservations(port, run, drained);
    }
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
    admitRecords(stored);
    void swLog({ event: 'tap-capture', count: stored.length, url: String(url).slice(0, 120) });
  })();
}

function postsFromTapPayload(payload) {
  return postsFromApiPayload(payload, { capturedAtMs: Date.now() });
}

const networkCapture = new NetworkCapture({ onResponse: handleTappedResponse });
networkCapture.attach();

// ------------------------------------------------------- body enrichment

const BODY_FETCH_DELAY_MS = 4000;
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
    if (observation) admitRecords([observation]);
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
