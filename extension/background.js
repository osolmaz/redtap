// redtap service worker: local capture store, unique-post export, and the
// Infinite Feed Scroller scrape bridge (xtap-scrape-v1 protocol).
import { canonical, observationId, postKey, shouldSampleUnchanged } from './lib/observations.js';
import { admitRecords, flushNowNow, initPoolSync, setConfig, statusSnapshot } from './lib/pool-sync.js';

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
  try {
    const log = (await store.get('bridgeLog', []));
    log.push({ at: Date.now(), ...entry });
    await store.set('bridgeLog', log.slice(-50));
  } catch {}
}

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
      const run = {
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
      };
      runs.set(message.runId, run);
      runPorts.set(message.runId, port);
      port.postMessage({
        type: 'scrape:opened',
        protocolVersion: SCRAPE_PROTOCOL_VERSION,
        runId: run.runId,
        run: { ...run, leaseExpiresAtMs: Date.now() + 60_000, protocolVersion: SCRAPE_PROTOCOL_VERSION },
        capabilities: ['search-timeline-observations', 'typed-errors', 'run-leases'],
        observations: [],
      });
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

void initPoolSync();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'redtap:capture') return;
  (async () => {
    const stored = [];
    for (const record of message.records ?? []) {
      const observation = await recordObservation(record);
      if (observation) stored.push(observation);
    }
    for (const [runId, port] of runPorts) {
      const run = runs.get(runId);
      if (run && stored.length > 0) sendObservations(port, run, stored);
    }
    admitRecords(stored);
    sendResponse({ stored: stored.length });
  })();
  return true;
});

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
