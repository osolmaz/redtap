// redtap pool sync — local ingest, no Space.
//
// Captured observations append to a persistent outbox in
// chrome.storage.local. Once per seal cycle (2h) the outbox is converted to
// v1 lines (bodies once per hash, tiny sight lines) and handed to the local
// ingest daemon by dropping a sealed segment into the downloads outbox via
// chrome.downloads. The cycle's path+uuid persist until the handoff
// succeeds, so retries are idempotent. On backoff the seal retries with
// exponential spacing; the outbox buffers for up to 30 days.

import { z } from 'zod';
import {
  bodyHash,
  EMPTY_BODY_HASH,
  hashesOf,
  toV1Lines,
  type Digest,
  type ObservationRecord,
  type V1Line,
} from './v1log.ts';
import { ObservationRecordSchema } from './schema.ts';

const OUTBOX_KEY = 'poolOutbox';
const HASHES_KEY = 'poolBodyHashes';
const CYCLE_KEY = 'poolSealCycle';
const STATE_KEY = 'poolStats';
const MAX_OUTBOX = 5000;
export const MAX_LINES_PER_COMMIT = 4000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const OUTBOX_RETENTION_MS = 30 * 24 * 3600_000;
export const CONFIG_KEYS = ['poolPaused', 'poolSubs', 'poolStats', 'bucketRepo', 'hubToken'];
export const DEFAULT_SUBS = ['LocalLLaMA'];
export const DEFAULT_BUCKET = 'osolmaz/redtap-data';
const SEAL_ALARM = 'redtap-pool-seal';
const INGEST_FOLDER = 'redtap-outbox';

export const PoolStatsSchema = z.object({
  synced: z.number(),
  queued: z.number(),
  lastError: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
});
export type PoolStats = z.infer<typeof PoolStatsSchema>;

const SealCycleSchema = z.object({
  path: z.string(),
  uuid: z.string(),
  sealedAtMs: z.number(),
});
type SealCycle = z.infer<typeof SealCycleSchema>;

const OutboxEntrySchema = ObservationRecordSchema.extend({ _admittedAt: z.number() });
type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

const StoredStateSchema = z.looseObject({
  poolOutbox: z.array(OutboxEntrySchema).catch([]).default([]),
  poolBodyHashes: z.array(z.string()).catch([]).default([]),
  poolSealCycle: SealCycleSchema.nullable().catch(null).default(null),
  poolStats: PoolStatsSchema.nullable().catch(null).default(null),
  bucketRepo: z.string().optional(),
  hubToken: z.string().optional(),
  poolPaused: z.boolean().optional(),
  poolSubs: z.string().optional(),
});

type PoolConfig = {
  bucketRepo: string;
  hubToken: string;
  poolPaused: boolean;
  subs: string[];
};

let outbox: OutboxEntry[] = [];
let knownHashes = new Set<string>();
let cycle: SealCycle | null = null; // fixed until its commit succeeds
let config: PoolConfig = {
  bucketRepo: DEFAULT_BUCKET,
  hubToken: '',
  poolPaused: false,
  subs: DEFAULT_SUBS,
};
let stats: PoolStats = { synced: 0, queued: 0, lastError: null, lastSyncAt: null };
let sealTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;
let sealing = false;

function storage(): chrome.storage.StorageArea {
  return globalThis.chrome.storage.local;
}

async function loadState(): Promise<void> {
  const bag = await storage().get([OUTBOX_KEY, HASHES_KEY, CYCLE_KEY, STATE_KEY, ...CONFIG_KEYS]);
  const stored = StoredStateSchema.parse(bag);
  outbox = stored.poolOutbox;
  knownHashes = new Set(stored.poolBodyHashes);
  cycle = stored.poolSealCycle;
  if (stored.poolStats !== null) stats = stored.poolStats;
  config = {
    bucketRepo: stored.bucketRepo?.includes('/') ? stored.bucketRepo : DEFAULT_BUCKET,
    hubToken: stored.hubToken ?? '',
    poolPaused: stored.poolPaused === true,
    subs: parseSubs(stored.poolSubs) ?? DEFAULT_SUBS,
  };
}

function persistCycle(): Promise<void> {
  return storage().set({ [CYCLE_KEY]: cycle });
}

/** Digest for v1log: hex sha256 via the worker's crypto.subtle. */
const digest: Digest = async (bytes) => {
  const view = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(view)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function admitRecords(records: ObservationRecord[]): void {
  const now = Date.now();
  for (const record of records) {
    outbox.push({ ...record, _admittedAt: now });
  }
  if (outbox.length > MAX_OUTBOX) outbox = outbox.slice(-MAX_OUTBOX);
  stats.queued = outbox.length;
  void storage().set({ [OUTBOX_KEY]: outbox, [STATE_KEY]: stats });
}

export function isConfigured(): boolean {
  return config.hubToken !== '' && config.bucketRepo.includes('/');
}

export function statusSnapshot() {
  return {
    ...stats,
    queued: outbox.length,
    paused: config.poolPaused,
    configured: isConfigured(),
    subs: config.subs,
    bucket: config.bucketRepo,
    cyclePath: cycle?.path ?? null,
  };
}

/** 'r/LocalLLaMA, askReddit' -> ['LocalLLaMA', 'AskReddit']; null when unset. */
export function parseSubs(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const subs = raw
    .split(',')
    .map((s) => s.trim().replace(/^r\//i, ''))
    .filter((s) => s.length > 0);
  return subs.length > 0 ? subs : null;
}

export function setConfig(next: Partial<PoolConfig>, flushNowFlag = false): void {
  const patch = { ...next };
  if (Array.isArray(patch.subs) && patch.subs.length === 0) delete patch.subs;
  config = { ...config, ...patch };
  void storage().set({
    bucketRepo: config.bucketRepo,
    hubToken: config.hubToken,
    poolPaused: config.poolPaused,
    poolSubs: config.subs.join(','),
    [STATE_KEY]: stats,
  });
  if (flushNowFlag) sealNow(true).catch(() => undefined);
}

/** Seal the outbox as one v1 segment and hand it off. force seals even when empty. */
export async function sealNow(force = false): Promise<number> {
  const trace = sealTrace();
  if (sealing || config.poolPaused || !isConfigured()) {
    trace('skip', { sealing, paused: config.poolPaused, configured: isConfigured() });
    return 0;
  }
  if (outbox.length === 0 && !force) {
    trace('skip-empty');
    return 0;
  }
  trace('start', { queued: outbox.length, force });
  sealing = true;
  try {
    return await sealBuffered(trace);
  } catch (error) {
    return sealFailed(trace, error);
  } finally {
    sealing = false;
  }
}

/** Structured seal tracing: console plus the injected background logger. */
function sealTrace(): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail = {}) => {
    console.log('[redtap-seal]', event, JSON.stringify(detail));
    void logFn?.({ event: 'seal-' + event, ...detail });
  };
}

/** Drop buffered records that aged past retention. */
function retainFreshOutbox(): void {
  const cutoff = Date.now() - OUTBOX_RETENTION_MS;
  outbox = outbox.filter((entry) => entry._admittedAt >= cutoff);
}

/** The records whose sight+body lines fit one commit. */
async function sealPrefix(records: ObservationRecord[]): Promise<ObservationRecord[]> {
  const sealed: ObservationRecord[] = [];
  let count = 0;
  const seen = new Set<string>();
  for (const record of records) {
    const h = await bodyHash(record, digest);
    const bodyLines = h !== EMPTY_BODY_HASH && !knownHashes.has(h) && !seen.has(h) ? 1 : 0;
    if (count + bodyLines + 1 > MAX_LINES_PER_COMMIT) break;
    seen.add(h);
    count += 1 + bodyLines;
    sealed.push(record);
  }
  return sealed;
}

/** The cycle's fixed v1 path: created once, kept until the handoff succeeds. */
async function sealCycle(): Promise<SealCycle> {
  if (cycle !== null) return cycle;
  const now = new Date();
  const uuid = crypto.randomUUID();
  const stamp = now.getTime().toString().padStart(13, '0');
  const day = now.toISOString().slice(0, 10).replace(/-/g, '/');
  cycle = SealCycleSchema.parse({
    path: `v1/log/${day}/${stamp}-${uuid}.jsonl.gz`,
    uuid,
    sealedAtMs: now.getTime(),
  });
  await persistCycle();
  return cycle;
}

/** Drop the sealed segment into the downloads outbox. The local ingest
 * daemon watches that folder and performs the bucket write from node — the
 * service worker's own fetches wedge, so no network fetch is used here. */
async function handoffSegment(cyclePath: string, lines: V1Line[]): Promise<number> {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const gzBytes = await gzipBytes(new TextEncoder().encode(text));
  if (gzBytes === null) throw new Error('gzip unavailable in worker');
  let binary = '';
  for (let i = 0; i < gzBytes.length; i += 0x8000) {
    binary += String.fromCharCode(...gzBytes.subarray(i, i + 0x8000));
  }
  return chrome.downloads.download({
    url: 'data:application/gzip;base64,' + btoa(binary),
    filename: `${INGEST_FOLDER}/` + cyclePath,
    conflictAction: 'overwrite',
  });
}

/** Commit the success state: hashes, outbox drain, stats, cycle clear. */
async function commitSeal(
  trace: (event: string, detail?: Record<string, unknown>) => void,
  sealed: ObservationRecord[],
  lines: V1Line[],
): Promise<number> {
  const sealedIds = new Set(sealed.map((r) => r.observation_id));
  for (const h of hashesOf(lines)) knownHashes.add(h);
  if (knownHashes.size > 200_000) knownHashes = new Set([...knownHashes].slice(-150_000));
  outbox = outbox.filter((r) => !sealedIds.has(r.observation_id));
  cycle = null;
  backoffMs = 0;
  stats.synced += sealed.length;
  stats.queued = outbox.length;
  stats.lastSyncAt = Date.now();
  stats.lastError = null;
  await storage().set({ [OUTBOX_KEY]: outbox, [HASHES_KEY]: [...knownHashes], [STATE_KEY]: stats });
  await persistCycle();
  return sealed.length;
}

/** The buffered seal: dedupe, cap, hand off, commit. */
async function sealBuffered(
  trace: (event: string, detail?: Record<string, unknown>) => void,
): Promise<number> {
  retainFreshOutbox();
  const records: ObservationRecord[] = outbox.map(({ _admittedAt, ...record }) => record);
  let lines = await toV1Lines(records, knownHashes, digest);
  if (lines.length === 0) {
    trace('deduped-to-zero');
    outbox = [];
    await storage().set({ [OUTBOX_KEY]: outbox });
    return 0;
  }
  trace('lines', { count: lines.length });
  // A record contributes one sight line plus a body line when its selftext is
  // new to the committed hashes. Seal the longest prefix that fits the commit
  // line cap; the outbox keeps the rest for the next cycle so the queue always
  // drains.
  let sealed = records;
  if (lines.length > MAX_LINES_PER_COMMIT) {
    sealed = await sealPrefix(records);
    lines = await toV1Lines(sealed, knownHashes, digest);
  }
  if (sealed.length === 0) return 0;
  const cyclePath = (await sealCycle()).path;
  trace('uploading', { path: cyclePath, lines: lines.length });
  const downloadId = await handoffSegment(cyclePath, lines);
  trace('handed-off', { downloadId });
  return commitSeal(trace, sealed, lines);
}

/** The next backoff for a seal failure, and the message the badge shows. */
function classifySealFailure(message: string): { backoff: number; display: string } {
  const match = /40[13]/.exec(message);
  if (match !== null) {
    return {
      backoff: BACKOFF_MAX_MS,
      display: 'auth failed (' + match[0] + '): fix the HF token; captures keep buffering',
    };
  }
  const factor = message.includes('429') ? 4 : 2;
  return {
    backoff: Math.min(BACKOFF_MAX_MS, (backoffMs || BACKOFF_BASE_MS) * factor),
    display: message.slice(0, 200),
  };
}

/** The failed seal: tag the error, schedule the backoff, keep the buffer. */
function sealFailed(
  trace: (event: string, detail?: Record<string, unknown>) => void,
  error: unknown,
): number {
  const message = String((error as Error | undefined)?.message ?? error);
  const { backoff, display } = classifySealFailure(message);
  stats.lastError = display;
  backoffMs = backoff;
  void storage().set({ [STATE_KEY]: stats });
  scheduleSeal(backoff);
  trace('failed', { error: message.slice(0, 120) });
  return 0;
}

export function scheduleSeal(delayMs = 0): void {
  if (sealTimer !== null) return;
  sealTimer = setTimeout(() => {
    sealTimer = null;
    void sealNow();
  }, delayMs);
}

export async function flushNowNow(): Promise<number> {
  await loadState();
  const before = outbox.length;
  await sealNow(true);
  return before - outbox.length;
}

// optional structured logger (wired from background.ts's swLog)
let logFn: ((entry: Record<string, unknown>) => Promise<void>) | null = null;

/** Register the seal + control alarms once; MV3 wakeups retry pending work. */
export async function initPoolSync({
  log,
}: { log?: (entry: Record<string, unknown>) => Promise<void> } = {}): Promise<void> {
  logFn = log ?? null;
  traceInit();
  await loadState();
  traceInitState();
  // alarms.create replaces an existing alarm of the same name, and the 1-minute
  // control poll wakes this worker constantly — recreating the seal alarm on
  // every wake would push its deadline out forever and seals would never run.
  // Create it once and let the 120-minute period recur.
  const sealAlarm = await chrome.alarms.get(SEAL_ALARM);
  if (sealAlarm === undefined) {
    chrome.alarms.create(SEAL_ALARM, { periodInMinutes: 120, delayInMinutes: 2 }).catch(() => undefined);
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SEAL_ALARM) {
      backoffMs = 0;
      sealNow().catch(() => undefined);
    }
  });
  // MV3 suspends the worker ~30s after its last event, which kills any
  // setTimeout-based retry before it fires. Run a pending seal inline instead:
  // every wake (the 1-minute control poll, captures, alarms) retries it, and
  // re-uploading the same cycle path is idempotent.
  if (cycle !== null) sealNow().catch(() => undefined);
}

function traceInit(): void {
  console.log('[redtap-seal] init-enter');
  void logFn?.({ event: 'seal-init-enter' });
}

function traceInitState(): void {
  const detail = {
    queued: outbox.length,
    cycle: cycle?.path ?? null,
    tokenLen: config.hubToken.length,
    bucket: config.bucketRepo,
  };
  console.log('[redtap-seal] init-state', JSON.stringify(detail));
  void logFn?.({ event: 'seal-init-state', ...detail });
}
