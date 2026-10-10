// redtap pool sync — local ingest, no Space.
//
// Captured observations append to a persistent outbox in
// chrome.storage.local. Once per seal cycle (2h) the outbox is converted to
// v2 lines (bodies once per hash, tiny sight lines) and POSTed to the local
// redtap server's /ingest endpoint, which performs the bucket write from
// node. The cycle's path+uuid persist until a commit succeeds, so retries
// are idempotent. On 429 the seal honors Retry-After with exponential
// backoff; on 401/403 the writer stops (red badge) and keeps buffering for
// up to 30 days.

import { bodyHash, EMPTY_BODY_HASH, hashesOf, toV2Lines } from './v2log.js';

const OUTBOX_KEY = 'poolOutbox';
const HASHES_KEY = 'poolBodyHashes';
const CYCLE_KEY = 'poolSealCycle';
const STATE_KEY = 'poolStats';
const MAX_OUTBOX = 5000;
const MAX_LINES_PER_COMMIT = 4000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const OUTBOX_RETENTION_MS = 30 * 24 * 3600_000;
export const CONFIG_KEYS = ['poolPaused', 'poolSubs', 'poolStats', 'bucketRepo', 'hubToken'];
export const DEFAULT_SUBS = ['LocalLLaMA'];
export const DEFAULT_BUCKET = 'osolmaz/redtap-data';
const SEAL_ALARM = 'redtap-pool-seal';
const INGEST_FOLDER = 'redtap-outbox';

let outbox = [];
let knownHashes = new Set();
let cycle = null; // { path, uuid, sealedAtMs } — fixed until its commit succeeds
let config = { bucketRepo: DEFAULT_BUCKET, hubToken: '', poolPaused: false, subs: DEFAULT_SUBS };
let stats = { synced: 0, queued: 0, lastError: null, lastSyncAt: null };
let sealTimer = null;
let backoffMs = 0;
let sealing = false;

function storage() {
  return globalThis.chrome.storage.local;
}

async function loadState() {
  const bag = await storage().get([OUTBOX_KEY, HASHES_KEY, CYCLE_KEY, STATE_KEY, ...CONFIG_KEYS]);
  outbox = Array.isArray(bag[OUTBOX_KEY]) ? bag[OUTBOX_KEY] : [];
  knownHashes = new Set(Array.isArray(bag[HASHES_KEY]) ? bag[HASHES_KEY] : []);
  cycle = bag[CYCLE_KEY] ?? null;
  stats = bag[STATE_KEY] ?? stats;
  config = {
    bucketRepo: typeof bag.bucketRepo === 'string' && bag.bucketRepo.includes('/') ? bag.bucketRepo : DEFAULT_BUCKET,
    hubToken: typeof bag.hubToken === 'string' ? bag.hubToken : '',
    poolPaused: bag.poolPaused === true,
    subs: parseSubs(bag.poolSubs) ?? DEFAULT_SUBS,
  };
}

function persistCycle() {
  return storage().set({ [CYCLE_KEY]: cycle });
}

/** Digest for v2log: hex sha256 via the worker's crypto.subtle. */
async function digest(bytes) {
  const view = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(view)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function gzipBytes(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function admitRecords(records) {
  const now = Date.now();
  for (const record of records) {
    outbox.push({ ...record, _admittedAt: now });
  }
  if (outbox.length > MAX_OUTBOX) outbox = outbox.slice(-MAX_OUTBOX);
  stats.queued = outbox.length;
  void storage().set({ [OUTBOX_KEY]: outbox, [STATE_KEY]: stats });
}

export function scheduleFlush() {}

export function isConfigured() {
  return config.hubToken !== '' && config.bucketRepo.includes('/');
}

export function statusSnapshot() {
  return { ...stats, queued: outbox.length, paused: config.poolPaused, configured: isConfigured(), subs: config.subs, bucket: config.bucketRepo, cyclePath: cycle?.path ?? null };
}

/** 'r/LocalLLaMA, askReddit' -> ['LocalLLaMA', 'AskReddit']; null when unset. */
export function parseSubs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const subs = raw.split(',').map((s) => s.trim().replace(/^r\//i, '')).filter((s) => s.length > 0);
  return subs.length > 0 ? subs : null;
}

export function setConfig(next, flushNowFlag = false) {
  const patch = { ...next };
  if (Array.isArray(patch.subs) && patch.subs.length === 0) delete patch.subs;
  config = { ...config, ...patch };
  void storage().set({
    bucketRepo: config.bucketRepo,
    hubToken: config.hubToken,
    poolPaused: config.poolPaused,
    poolSubs: (config.subs ?? DEFAULT_SUBS).join(','),
    [STATE_KEY]: stats,
  });
  if (flushNowFlag) void sealNow(true);
}

/** Seal the outbox as one v2 segment and commit it. force seals early (tests). */
export async function sealNow(force = false) {
  const trace = (event, detail) => {
    try { console.log('[redtap-seal]', event, JSON.stringify(detail ?? {})); } catch {}
    try { logFn?.({ event: 'seal-' + event, ...detail }); } catch {}
  };
  // declared before the try so early throws can still be tagged in the catch
  let whoamiProbe = null;
  if (sealing || config.poolPaused || !isConfigured()) { trace('skip', { sealing, paused: config.poolPaused, configured: isConfigured() }); return 0; }
  if (outbox.length === 0 && !force) { trace('skip-empty'); return 0; }
  trace('start', { queued: outbox.length, force });
  sealing = true;
  try {
    // drop stale lines past retention
    const cutoff = Date.now() - OUTBOX_RETENTION_MS;
    outbox = outbox.filter((r) => (r._admittedAt ?? Date.now()) >= cutoff);

    const records = outbox.map(({ _admittedAt, ...record }) => record);
    let lines = await toV2Lines(records, knownHashes, digest);
    if (lines.length === 0) { trace('deduped-to-zero'); outbox = []; await storage().set({ [OUTBOX_KEY]: outbox }); return 0; }
    trace('lines', { count: lines.length });
    // A record contributes one sight line plus a body line when its selftext is
    // new to the committed hashes. Seal the longest prefix that fits the commit
    // line cap; the outbox keeps the rest for the next cycle so the queue always
    // drains.
    let sealed = records;
    if (lines.length > MAX_LINES_PER_COMMIT) {
      sealed = [];
      let count = 0;
      const seen = new Set();
      for (const record of records) {
        if (!record?.post_id || !record?.observation_id) continue;
        const h = await bodyHash(record, digest);
        const bodyLines = h !== EMPTY_BODY_HASH && !knownHashes.has(h) && !seen.has(h) ? 1 : 0;
        if (count + bodyLines + 1 > MAX_LINES_PER_COMMIT) break;
        seen.add(h);
        count += 1 + bodyLines;
        sealed.push(record);
      }
      lines = await toV2Lines(sealed, knownHashes, digest);
    }
    const sealedIds = new Set(sealed.map((r) => r.observation_id));
    const sealedCount = sealed.length;
    if (sealedCount === 0) return 0;

    if (!cycle) {
      const now = new Date();
      const uuid = crypto.randomUUID();
      const stamp = String(now.getTime()).padStart(13, '0');
      const day = now.toISOString().slice(0, 10).replace(/-/g, '/');
      cycle = { path: `v2/log/${day}/${stamp}-${uuid}.jsonl.gz`, uuid, sealedAtMs: now.getTime() };
      await persistCycle();
    }

    // Drop the sealed segment into ~/Downloads/redtap-outbox/ via the
    // downloads API. The local redtap server watches that folder and performs
    // the bucket write from node — the service worker's own fetches wedge on
    // the loopback POST, so no network fetch is used here.
    const finalPath = cycle.path;
    trace('uploading', { path: finalPath, lines: lines.length });
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const gzBytes = await gzipBytes(new TextEncoder().encode(text));
    if (!gzBytes) throw new Error('gzip unavailable in worker');
    let binary = '';
    for (let i = 0; i < gzBytes.length; i += 0x8000) {
      binary += String.fromCharCode(...gzBytes.subarray(i, i + 0x8000));
    }
    const downloadId = await chrome.downloads.download({
      url: 'data:application/gzip;base64,' + btoa(binary),
      filename: 'redtap-outbox/' + finalPath,
      conflictAction: 'overwrite',
    });
    trace('handed-off', { downloadId });

    // success: commit the body hashes, drop the sealed records, clear the cycle
    for (const h of hashesOf(lines)) knownHashes.add(h);
    if (knownHashes.size > 200_000) knownHashes = new Set([...knownHashes].slice(-150_000));
    outbox = outbox.filter((r) => !sealedIds.has(r.observation_id));
    cycle = null;
    backoffMs = 0;
    stats.synced += sealedCount;
    stats.queued = outbox.length;
    stats.lastSyncAt = Date.now();
    stats.lastError = null;
    await storage().set({ [OUTBOX_KEY]: outbox, [HASHES_KEY]: [...knownHashes], [STATE_KEY]: stats });
    await persistCycle();
    return records.length;
  } catch (error) {
    const message = String(error?.message ?? error);
    stats.lastError = (whoamiProbe ? '[' + whoamiProbe + '] ' : '') + message.slice(0, 200);
    if (/status (401|403)/.test(message) || /401|403/.test(message)) {
      stats.lastError = 'auth failed (' + (message.match(/40[13]/)?.[0] ?? '40x') + '): fix the HF token; captures keep buffering';
      backoffMs = BACKOFF_MAX_MS;
    } else if (/429/.test(message)) {
      backoffMs = Math.min(BACKOFF_MAX_MS, (backoffMs || BACKOFF_BASE_MS) * 4);
    } else {
      backoffMs = Math.min(BACKOFF_MAX_MS, (backoffMs || BACKOFF_BASE_MS) * 2);
    }
    await storage().set({ [STATE_KEY]: stats });
    scheduleSeal(backoffMs);
    return 0;
  } finally {
    sealing = false;
  }
}

export function scheduleSeal(delayMs = 0) {
  if (sealTimer !== null) return;
  sealTimer = setTimeout(() => {
    sealTimer = null;
    void sealNow();
  }, delayMs);
}

export async function flushNowNow() {
  await loadState();
  const before = outbox.length;
  await sealNow(true);
  return before - outbox.length;
}

// optional structured logger (wired from background.js's swLog)
let logFn = null;

export async function initPoolSync({ log } = {}) {
  logFn = log ?? null;
  try { console.log('[redtap-seal] init-enter'); } catch {}
  try { logFn?.({ event: 'seal-init-enter' }); } catch {}
  await loadState();
  try { console.log('[redtap-seal] init-state', JSON.stringify({ queued: outbox.length, cycle: cycle?.path ?? null, tokenLen: String(config.hubToken).length })); } catch {}
  try { logFn?.({ event: 'seal-init-state', queued: outbox.length, cycle: cycle?.path ?? null, tokenLen: String(config.hubToken).length, bucket: config.bucketRepo }); } catch {}
  // alarms.create replaces an existing alarm of the same name, and the 1-minute
  // control poll wakes this worker constantly — recreating the seal alarm on
  // every wake would push its deadline out forever and seals would never run.
  // Create it once and let the 120-minute period recur.
  const sealAlarm = await chrome.alarms.get(SEAL_ALARM);
  if (!sealAlarm) chrome.alarms.create(SEAL_ALARM, { periodInMinutes: 120, delayInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SEAL_ALARM) {
      backoffMs = 0;
      void sealNow();
    }
  });
  // MV3 suspends the worker ~30s after its last event, which kills any
  // setTimeout-based retry before it fires. Run a pending seal inline instead:
  // every wake (the 1-minute control poll, captures, alarms) retries it, and
  // re-uploading the same cycle path is idempotent.
  try { logFn?.({ event: 'seal-init-dispatch', hasCycle: !!cycle }); } catch {}
  if (cycle) void sealNow();
}
