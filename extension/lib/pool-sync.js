// redtap pool sync — background sync of captured observations to the pool
// Space. Mirror of xtap-pool's lib/pool-sync.js: records append to a
// persistent queue in chrome.storage.local and flush in batches to
// POST <poolUrl>/api/ingest with the pool token. Delivery is at-least-once;
// the Space deduplicates by observation id.

const QUEUE_KEY = 'poolQueue';
const MAX_QUEUE = 5000;
const MAX_BATCH = 400;
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
export const CONFIG_KEYS = ['poolUrl', 'poolToken', 'poolPaused', 'poolStats'];

let queue = [];
let config = { poolUrl: '', poolToken: '', poolPaused: false };
let stats = { synced: 0, queued: 0, lastError: null, lastSyncAt: null };
let flushTimer = null;
let backoffMs = 0;
let flushing = false;

function storage() {
  return globalThis.chrome.storage.local;
}

async function loadState() {
  const bag = await storage().get([QUEUE_KEY, ...CONFIG_KEYS]);
  queue = Array.isArray(bag[QUEUE_KEY]) ? bag[QUEUE_KEY] : [];
  config = {
    poolUrl: typeof bag.poolUrl === 'string' ? bag.poolUrl : '',
    poolToken: typeof bag.poolToken === 'string' ? bag.poolToken : '',
    poolPaused: bag.poolPaused === true,
  };
  stats = bag.poolStats ?? stats;
}

async function persistQueue() {
  await storage().set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
}

export function admitRecords(records) {
  queue.push(...records);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  stats.queued = queue.length;
  void persistQueue();
  scheduleFlush(FLUSH_DEBOUNCE_MS);
}

export function scheduleFlush(delayMs = 0) {
  if (flushTimer !== null || config.poolPaused) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, delayMs);
}

export function isConfigured() {
  return config.poolUrl !== '' && config.poolToken !== '';
}

export function statusSnapshot() {
  return { ...stats, queued: queue.length, paused: config.poolPaused, configured: isConfigured() };
}

export async function flushNowNow() {
  await loadState();
  const before = queue.length;
  backoffMs = 0;
  await flushNow();
  return before - queue.length;
}

export function setConfig(next, flushNowFlag = false) {
  config = { ...config, ...next };
  void storage().set({
    poolUrl: config.poolUrl,
    poolToken: config.poolToken,
    poolPaused: config.poolPaused,
    poolStats: stats,
  });
  if (flushNowFlag) scheduleFlush(200);
  else scheduleFlush(1000);
}

async function flushNow() {
  if (flushing || !isConfigured() || config.poolPaused || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      const response = await fetch(config.poolUrl.replace(/\/$/, '') + '/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.poolToken },
        body: JSON.stringify({ records: batch }),
      });
      if (response.status === 401 || response.status === 400) {
        stats.lastError = 'pool rejected the batch (' + response.status + ')';
        await storage().set({ poolStats: stats });
        queue = response.status === 400 ? queue.slice(batch.length) : queue;
        if (response.status === 400) void persistQueue();
        backoffMs = Math.min(BACKOFF_MAX_MS, (backoffMs || BACKOFF_BASE_MS) * 2);
        scheduleFlush(backoffMs);
        return;
      }
      if (!response.ok) throw new Error('pool responded ' + response.status);
      queue = queue.slice(batch.length);
      backoffMs = 0;
      stats.synced += batch.length;
      stats.lastSyncAt = Date.now();
      stats.lastError = null;
      await persistQueue();
      await storage().set({ poolStats: stats });
    }
  } catch (error) {
    stats.lastError = String(error?.message ?? error).slice(0, 200);
    backoffMs = Math.min(BACKOFF_MAX_MS, (backoffMs || BACKOFF_BASE_MS) * 2);
    await storage().set({ poolStats: stats });
    scheduleFlush(backoffMs);
  } finally {
    flushing = false;
  }
}

export async function initPoolSync() {
  await loadState();
  // 30s (the alarms minimum) keeps the service worker effectively always alive, so cross-extension
  // bridge connects are never lost to worker shutdown.
  chrome.alarms.create('redtap-pool-flush', { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'redtap-pool-flush') {
      backoffMs = 0;
      void flushNow();
    }
  });
  scheduleFlush(2000);
}
