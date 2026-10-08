// redtap pool sync — direct bucket writes, no Space.
//
// Captured observations append to a persistent outbox in
// chrome.storage.local. Once per seal cycle (2h) the outbox is converted to
// v2 lines (bodies once per hash, tiny sight lines), gzipped, and committed
// to the HF bucket at an immutable path. The cycle's path+uuid persist until
// a commit succeeds, so retries are idempotent. On 429 the upload honors
// Retry-After with exponential backoff; on 401/403 the writer stops (red
// badge) and keeps buffering for up to 30 days.

import { uploadFile } from './vendor/index.mjs';
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
export const CONFIG_KEYS = ['poolUrl', 'poolToken', 'poolPaused', 'poolSubs', 'poolStats', 'bucketRepo', 'hubToken'];
export const DEFAULT_SUBS = ['LocalLLaMA'];
export const DEFAULT_BUCKET = 'osolmaz/redtap-data';
const SEAL_ALARM = 'redtap-pool-seal';

let outbox = [];
let knownHashes = new Set();
let cycle = null; // { path, uuid, sealedAtMs } — fixed until its commit succeeds
let config = { poolUrl: '', poolToken: '', bucketRepo: DEFAULT_BUCKET, hubToken: '', poolPaused: false, subs: DEFAULT_SUBS };
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
    poolUrl: typeof bag.poolUrl === 'string' ? bag.poolUrl : '',
    poolToken: typeof bag.poolToken === 'string' ? bag.poolToken : '',
    bucketRepo: typeof bag.bucketRepo === 'string' && bag.bucketRepo.includes('/') ? bag.bucketRepo : DEFAULT_BUCKET,
    hubToken: typeof bag.hubToken === 'string' ? bag.hubToken : bag.poolToken ?? '',
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
    poolUrl: config.poolUrl,
    poolToken: config.poolToken,
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
  if (sealing || config.poolPaused || !isConfigured()) return 0;
  if (outbox.length === 0 && !force) return 0;
  sealing = true;
  try {
    // drop stale lines past retention
    const cutoff = Date.now() - OUTBOX_RETENTION_MS;
    outbox = outbox.filter((r) => (r._admittedAt ?? Date.now()) >= cutoff);

    const records = outbox.map(({ _admittedAt, ...record }) => record);
    let lines = await toV2Lines(records, knownHashes, digest);
    if (lines.length === 0) { outbox = []; await storage().set({ [OUTBOX_KEY]: outbox }); return 0; }
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

    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const gz = await gzipBytes(new TextEncoder().encode(text));
    const content = gz ? new Blob([gz]) : new Blob([text]);
    const finalPath = gz ? cycle.path : cycle.path.replace(/\.gz$/, '.jsonl');

    await uploadFile({
      repo: { type: 'bucket', name: config.bucketRepo },
      accessToken: config.hubToken,
      file: { path: finalPath, content },
      commitTitle: 'redtap: seal ' + lines.length + ' v2 lines (' + sealedCount + ' records)',
    });

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
    stats.lastError = message.slice(0, 200);
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

export async function initPoolSync() {
  await loadState();
  chrome.alarms.create(SEAL_ALARM, { periodInMinutes: 120, delayInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SEAL_ALARM) {
      backoffMs = 0;
      void sealNow();
    }
  });
  // a failed commit retries on the worker's next wake; the alarm minimum is 30s
  if (cycle) scheduleSeal(backoffMs || 40_000);
}
