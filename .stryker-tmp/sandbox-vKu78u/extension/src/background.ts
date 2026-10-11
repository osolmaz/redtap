// @ts-nocheck
// redtap service worker: local capture store, unique-post export, and the
// Infinite Feed Scroller scrape bridge (xtap-scrape-v1 protocol).
console.log(
  '[redtap-bg] fresh module load, manifest',
  chrome.runtime.getManifest().version + ', ingest build',
);
import { z } from 'zod';
import {
  observationId,
  postsFromApiPayload,
  recordFromApiPost,
  shouldSampleUnchanged,
} from './lib/observations.ts';
import { PostRecordSchema, type ObservationRecord, type PostRecord } from './lib/schema.ts';
import { admitRecords, flushNowNow, initPoolSync, setConfig, statusSnapshot } from './lib/pool-sync.ts';
import { NetworkCapture } from './lib/network-capture.ts';
import { initControl } from './lib/control.ts';

// ---------------------------------------------------------------- storage

const store = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const bag = await chrome.storage.local.get(key);
    return key in bag ? (bag[key] as T) : fallback;
  },
  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
};

type SampleState = {
  samples: Record<string, { observation_id: string; lastSeenAtMs: number }>;
  exportedIds: string[];
};

function subAllowed(subreddit: unknown): boolean {
  const subs = statusSnapshot().subs.map((s) => s.toLowerCase());
  if (typeof subreddit !== 'string' || subreddit === '') return true; // unknown source: let the store dedupe
  const bare = subreddit.replace(/^r\//i, '').toLowerCase();
  return subs.includes(bare);
}

async function recordObservation(record: PostRecord): Promise<ObservationRecord | null> {
  if (!record.post_id) return null;
  if (!subAllowed(record.subreddit)) return null;
  const observation = { ...record, observation_id: await observationId(record) };
  const state = await store.get<SampleState>('redtapState', { samples: {}, exportedIds: [] });
  const samples = state.samples;
  const prior = samples[observation.post_id];
  if (
    prior?.observation_id === observation.observation_id &&
    !shouldSampleUnchanged(prior.lastSeenAtMs, Date.now())
  ) {
    return null;
  }
  // No local archive: the bucket's v1 log is the archive. Writing a growing
  // array here re-serialized megabytes per capture and wedged the worker.
  samples[observation.post_id] = {
    observation_id: observation.observation_id,
    lastSeenAtMs: Date.now(),
  };
  await store.set('redtapState', state);
  return observation;
}

async function storeRecords(records: PostRecord[]): Promise<ObservationRecord[]> {
  const stored: ObservationRecord[] = [];
  for (const record of records) {
    const observation = await recordObservation(record);
    if (observation) stored.push(observation);
  }
  return stored;
}

// Every observation source funnels through this one path: the records join
// each open scrape run's pending queue, the pool outbox, the body-enrichment
// queue, and the session badge.
function ingestStored(stored: ObservationRecord[]): void {
  if (stored.length === 0) return;
  feedBridge(stored);
  admitRecords(stored);
  enqueueBodyFetch(stored);
  sessionBadgeCount += stored.length;
  updateBadge();
}

// ------------------------------------------------------- scrape bridge (IFS)

const SCRAPE_PORT_NAME = 'xtap-scrape-v1';
const SCRAPE_PROTOCOL_VERSION = 1;
const SCROLLER_EXTENSION_ID = 'aahdialpkbjlbfjkpamfclbnlbinekal';

type BridgeRun = {
  runId: string;
  sourceTabId?: number;
  listId?: string;
  afterCursor: number;
  lastCursor: number;
  baselineSequence: number;
  knownListCount: number;
  nextCaptureSequence: number;
  startedAtMs: number;
  state: string;
  updatedAtMs: number;
  pending: ObservationRecord[];
  restored?: boolean;
  openedAtMs?: number;
  drainCount?: number;
  lastCursorAtMs?: number;
};

const BridgeMessageSchema = z.looseObject({
  type: z.string().optional(),
  protocolVersion: z.unknown(),
  runId: z.string().optional(),
  sourceTabId: z.number().optional(),
  listId: z.string().optional(),
  afterCursor: z.number().optional(),
  startedAtMs: z.number().optional(),
  state: z.string().optional(),
  renewedAtMs: z.number().optional(),
});
type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

const runs = new Map<string, BridgeRun>();
const runPorts = new Map<string, chrome.runtime.Port>();

function toWire(run: BridgeRun, records: ObservationRecord[], nowMs: number) {
  return records.map((record) => ({
    cursor: (run.lastCursor += 1),
    knownBeforeRun: Boolean((record as ObservationRecord & { knownBeforeRun?: unknown }).knownBeforeRun),
    observedAtMs: nowMs,
    postAt: canonicalPostAt(record.post_at, nowMs),
    sourceEndpoint: record.source_endpoint || '/r/unknown',
    tweetId: record.post_id,
    captureSequence: run.nextCaptureSequence++,
    runId: run.runId,
    sourceTabId: run.sourceTabId,
  }));
}

function sendObservations(port: chrome.runtime.Port, run: BridgeRun, records: ObservationRecord[]): void {
  const nowMs = Date.now();
  port.postMessage({
    type: 'scrape:observations',
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
    runId: run.runId,
    observations: toWire(run, records, nowMs),
  });
}

async function bridgeLog(entry: Record<string, unknown>): Promise<void> {
  console.log('[redtap-bridge]', JSON.stringify(entry));
  try {
    const log = await store.get<Record<string, unknown>[]>('bridgeLog', []);
    log.push({ at: Date.now(), ...entry });
    await store.set('bridgeLog', log.slice(-50));
  } catch {
    // logging must never break the bridge
  }
}

function createRun(message: BridgeMessage): BridgeRun {
  return {
    runId: message.runId ?? '',
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

function respondRun(run: BridgeRun) {
  const { pending: _pending, ...rest } = run;
  return {
    ...rest,
    leaseExpiresAtMs: Date.now() + 60_000,
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
  };
}

// ------------------------------------------------------------ run persistence

// The MV3 service worker idles out within seconds and the runs map dies with
// it; the scroller then reconnects and a fresh run would reset the cursor,
// making the client drop every redelivered observation. Persist runs and
// restore them on re-open so cursors and pending queues survive restarts.
const RUNS_KEY = 'bridgeRuns';

function persistRuns(): void {
  const payload = [...runs.values()].map((run) => ({ ...run, pending: run.pending.slice(-500) }));
  void store.set(RUNS_KEY, payload).catch((error: unknown) => {
    void swLog({ event: 'runs-persist-failed', error: String(error).slice(0, 120) });
  });
}

async function openRun(message: BridgeMessage): Promise<BridgeRun> {
  const runId = message.runId ?? '';
  const existing = runs.get(runId);
  if (existing) return existing;
  const stored = await store.get<BridgeRun[]>(RUNS_KEY, []);
  const saved = (Array.isArray(stored) ? stored : []).find((run) => run.runId === runId);
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
let capturesStored = 0;
let pollRequests = 0;
let pendingPushed = 0;

// --- badge (xtap parity, reddit colors) ---

function updateBadge(): void {
  if (!poolSyncHealthy) {
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#E0245E' });
    return;
  }
  void chrome.action.setBadgeText({ text: sessionBadgeCount > 0 ? String(sessionBadgeCount) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#FF4500' });
}

function refreshSyncHealth(): void {
  const snap = statusSnapshot();
  poolSyncHealthy = !snap.configured || snap.lastError === null;
  updateBadge();
}
setInterval(refreshSyncHealth, 30_000);

// Drain the run's pending captures into a wire-shaped observations reply.
// postAt must be canonical UTC (Z-form) or the client drops the whole batch;
// reddit ships +00:00 offsets, so normalize everything through Date.
function canonicalPostAt(value: string | null, fallbackMs: number): string {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(fallbackMs).toISOString();
}

function observationsReply(run: BridgeRun) {
  const drained = run.pending.splice(0);
  run.drainCount = (run.drainCount ?? 0) + 1;
  run.lastCursorAtMs = Date.now();
  persistRuns();
  const nowMs = Date.now();
  return {
    type: 'scrape:observations',
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
    runId: run.runId,
    observations: toWire(run, drained, nowMs),
  };
}

function runsSnapshot() {
  return [...runs.values()].map((run) => ({
    runId: run.runId.slice(0, 8),
    state: run.state,
    ageMs: Date.now() - run.startedAtMs,
    pending: run.pending.length,
  }));
}

function feedBridge(stored: ObservationRecord[]): void {
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

function postBridgeError(port: chrome.runtime.Port, runId: string, errorCode: string, error: string): void {
  port.postMessage({
    type: 'scrape:error',
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
    runId,
    errorCode,
    error,
  });
}

async function replyOpened(port: chrome.runtime.Port, message: BridgeMessage): Promise<void> {
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
    await bridgeLog({ event: 'reply-sent', runId: run.runId });
  } catch (err) {
    await bridgeLog({ event: 'reply-failed', runId: run.runId, error: String(err).slice(0, 120) });
  }
}

function replyPoll(port: chrome.runtime.Port, message: BridgeMessage): void {
  pollRequests += 1;
  const run = runs.get(message.runId ?? '');
  if (run === undefined) {
    postBridgeError(port, message.runId ?? '', 'unknown-run', 'unknown run');
    return;
  }
  run.updatedAtMs = Date.now();
  port.postMessage(observationsReply(run));
}

function replyFinish(port: chrome.runtime.Port, message: BridgeMessage): void {
  const run = runs.get(message.runId ?? '');
  if (run !== undefined) run.state = message.state ?? 'completed';
  port.postMessage({
    type: 'scrape:finished',
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
    runId: message.runId,
    run: run === undefined ? undefined : respondRun(run),
  });
  runs.delete(message.runId ?? '');
  runPorts.delete(message.runId ?? '');
  persistRuns();
}

function dispatchBridgeMessage(port: chrome.runtime.Port, message: BridgeMessage): void {
  if (message.protocolVersion !== SCRAPE_PROTOCOL_VERSION) {
    postBridgeError(port, message.runId ?? '', 'invalid-request', 'unsupported protocol version');
    return;
  }
  if (message.type === 'scrape:open') {
    void replyOpened(port, message).catch(() => undefined);
    return;
  }
  if (message.type === 'scrape:poll') {
    replyPoll(port, message);
    return;
  }
  replyRunStatus(port, message);
}

/** heartbeat/finish: both only touch the run's lifecycle state. */
function replyRunStatus(port: chrome.runtime.Port, message: BridgeMessage): void {
  if (message.type === 'scrape:heartbeat') {
    const run = runs.get(message.runId ?? '');
    if (run !== undefined) run.updatedAtMs = message.renewedAtMs ?? Date.now();
    return;
  }
  if (message.type === 'scrape:finish') replyFinish(port, message);
}

function onBridgeMessage(port: chrome.runtime.Port, rawMessage: unknown): void {
  const parsed = BridgeMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    postBridgeError(port, '', 'invalid-request', 'unsupported protocol version');
    return;
  }
  void bridgeLog({ event: 'message', type: parsed.data.type, pv: parsed.data.protocolVersion });
  dispatchBridgeMessage(port, parsed.data);
}

function onBridgeDisconnect(port: chrome.runtime.Port): void {
  for (const [runId, boundPort] of runPorts) {
    if (boundPort !== port) continue;
    runPorts.delete(runId);
    runs.delete(runId);
    persistRuns();
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  void bridgeLog({
    event: 'connect',
    name: port.name,
    sender: port.sender?.id,
    senderUrl: port.sender?.url?.slice(0, 60),
  });
  if (port.name !== SCRAPE_PORT_NAME) {
    void bridgeLog({ event: 'reject-name', name: port.name });
    return;
  }
  if (port.sender?.id !== SCROLLER_EXTENSION_ID) {
    void bridgeLog({ event: 'reject-sender', sender: port.sender?.id });
    port.disconnect();
    return;
  }
  port.onMessage.addListener((rawMessage: unknown): void => {
    onBridgeMessage(port, rawMessage);
  });
  port.onDisconnect.addListener((): void => {
    onBridgeDisconnect(port);
  });
});

// ------------------------------------------------------------ message wiring

async function swLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const log = await store.get<Record<string, unknown>[]>('swLog', []);
    log.push({ at: Date.now(), ...entry });
    await store.set('swLog', log.slice(-80));
  } catch {
    // logging must never break the worker
  }
}

const boot = (async () => {
  await swLog({ event: 'sw-start' });
  try {
    await initPoolSync({ log: swLog });
    await swLog({ event: 'pool-sync-init-ok' });
  } catch (error) {
    await swLog({
      event: 'pool-sync-init-failed',
      error: String((error as Error | undefined)?.message ?? error).slice(0, 150),
    });
  }
  // No boot-time body backfill from a local archive: the archive is gone and
  // the bucket owns committed history. Fresh captures enrich as they arrive.
  await swLog({ event: 'boot-ready' });
})();
void boot;

initControl({
  getConfig: async () => {
    const bag = await chrome.storage.local.get(['bucketRepo', 'hubToken']);
    return {
      bucketRepo: typeof bag.bucketRepo === 'string' ? bag.bucketRepo : 'osolmaz/redtap-data',
      hubToken: typeof bag.hubToken === 'string' ? bag.hubToken : '',
    };
  },
  onFlush: () => flushNowNow(),
  heartbeat: async () => {
    const wall = await probeWall();
    const [logBag, bridgeLogTail] = await Promise.all([
      chrome.storage.local.get('swLog'),
      store.get<Record<string, unknown>[]>('bridgeLog', []),
    ]);
    const snapshot = statusSnapshot();
    return {
      lines: snapshot.queued,
      selftextLines: snapshot.synced,
      swLog: readLogTail(logBag.swLog).slice(-8),
      bridgeLog: readLogTail(bridgeLogTail).slice(-10),
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

// ------------------------------------------------------------ network tap

function handleTappedResponse({ data, url }: { data: unknown; url: string }): void {
  tapCaptured(data, url).catch(() => undefined);
}

async function tapCaptured(data: unknown, url: string): Promise<void> {
  const records = postsFromApiPayload(data, { capturedAtMs: Date.now() });
  if (records.length === 0) return;
  const stored = await storeRecords(records);
  if (stored.length === 0) return;
  ingestStored(stored);
  void swLog({ event: 'tap-capture', count: stored.length, url: url.slice(0, 120) });
}

const networkCapture = new NetworkCapture({ onResponse: handleTappedResponse });
networkCapture.attach();

// --------------------------------------------------- listing backfill pages

// The feed tab cannot page past reddit's logged-out cap (~500 posts), so a
// month of a busy subreddit never fits through scrolling alone. Page the
// public listing .json API directly: it supports `after` cursors, works
// logged out, and each response carries full post data (created time, body,
// score) through the same capture path as the network tap.

const REDDIT_FETCH_GAP_MS = 3000;
const listingState: { lastAtMs: number | null; lastPages: number; lastTotal: number; running: boolean } = {
  lastAtMs: null,
  lastPages: 0,
  lastTotal: 0,
  running: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One rate gate for every reddit .json fetch: the listing paginator and the
// body enrichment share reddit's per-IP budget, so uncoordinated bursts
// from either get the whole worker rate-limited.
let redditFetchChain: Promise<void> = Promise.resolve();

/** The stored log entries, tolerating whatever shape storage returns. */
function readLogTail(stored: unknown): Record<string, unknown>[] {
  return Array.isArray(stored) ? (stored as Record<string, unknown>[]) : [];
}

function redditFetch(url: string): Promise<Response> {
  const run = redditFetchChain.then(() => fetch(url, { credentials: 'include' }));
  const release = run.catch(() => undefined).then(() => sleep(REDDIT_FETCH_GAP_MS));
  redditFetchChain = release;
  return run;
}

/** Honor a listing 429: pause a minute, or give up after three retries. */
async function retryListingAfter429(retries: number, page: number): Promise<number> {
  if (retries >= 3) throw new Error('listing rate-limited after retries');
  void swLog({ event: 'listing-429', page: page + 1, retry: retries + 1 });
  await sleep(60_000);
  return retries + 1;
}

async function paginateListing(
  path: string,
  params: Record<string, string>,
  { maxPages = 15 }: { maxPages?: number } = {},
): Promise<{ pages: number; total: number }> {
  let after = '';
  let pages = 0;
  let total = 0;
  let retries = 0;
  while (pages < maxPages) {
    const query = listingQuery(params, after);
    const response = await fetch(`https://www.reddit.com${path}?${query}`, { credentials: 'include' });
    if (response.status === 429) {
      retries = await retryListingAfter429(retries, pages);
      continue;
    }
    retries = 0;
    if (!response.ok) throw new Error(`listing responded ${response.status}`);
    const payload: unknown = await response.json();
    const stored = await ingestListingPage(payload);
    if (stored === 0) break;
    pages += 1;
    total += stored;
    void swLog({ event: 'listing-page', path, page: pages, stored });
    after = readAfter(payload);
    if (after === '') break;
    await sleep(REDDIT_FETCH_GAP_MS);
  }
  return { pages, total };
}

function listingQuery(params: Record<string, string>, after: string): string {
  const query = new URLSearchParams({ limit: '100', raw_json: '1', ...params });
  if (after !== '') query.set('after', after);
  return query.toString();
}

/** Store one listing payload's posts; returns how many survived the gates. */
async function ingestListingPage(payload: unknown): Promise<number> {
  const records = postsFromApiPayload(payload, { capturedAtMs: Date.now() });
  if (records.length === 0) return 0;
  const stored = await storeRecords(records);
  ingestStored(stored);
  return stored.length;
}

function readAfter(payload: unknown): string {
  const data = (payload as { data?: { after?: unknown } } | null)?.data;
  return typeof data?.after === 'string' ? data.after : '';
}

async function runListingBackfill(): Promise<void> {
  if (listingState.running) return;
  listingState.running = true;
  // The paginator fetches directly at its own pace while the body queue is
  // paused: queued body fetches ahead of a listing page would idle the
  // worker past MV3's 30s kill and abort the pagination mid-run.
  bodyQueuePaused = true;
  try {
    const sub = statusSnapshot().subs[0] ?? 'LocalLLaMA';
    const month = await paginateListing('/r/' + sub + '/top/.json', { t: 'month' }, { maxPages: 15 });
    const fresh = await paginateListing('/r/' + sub + '/new/.json', {}, { maxPages: 5 });
    listingState.lastAtMs = Date.now();
    listingState.lastPages = month.pages + fresh.pages;
    listingState.lastTotal = month.total + fresh.total;
    void swLog({ event: 'listing-backfill', month: month.total, fresh: fresh.total });
  } catch (error) {
    void swLog({
      event: 'listing-backfill-failed',
      error: String((error as Error | undefined)?.message ?? error).slice(0, 120),
    });
  } finally {
    bodyQueuePaused = false;
    listingState.running = false;
  }
}

const LISTING_ALARM = 'redtap-listing-backfill';
chrome.alarms.create(LISTING_ALARM, { periodInMinutes: 120, delayInMinutes: 2 }).catch(() => undefined);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LISTING_ALARM) runListingBackfill().catch(() => undefined);
});

// ------------------------------------------------------- body enrichment

const BODY_FETCH_DELAY_MS = 1500;
const BODY_QUEUE_MAX = 500;
type BodyItem = { post_id: string; permalink: string };
const bodyQueue: BodyItem[] = [];
const bodyFailed = new Set<string>();
let bodyBusy = false;
let bodyQueuePaused = false;
let bodyTimer: ReturnType<typeof setTimeout> | null = null;

/** A record is enrichable when it has a permalink and no body yet. */
/** A record is enrichable when it has a permalink and no body yet. */
function needsBodyFetch(record: ObservationRecord): boolean {
  return record.post_id !== '' && record.permalink !== '' && record.selftext === undefined;
}

function admitBodyItem(record: ObservationRecord): boolean {
  if (!needsBodyFetch(record) || bodyFailed.has(record.post_id)) return false;
  if (bodyQueue.some((item) => item.post_id === record.post_id)) return false;
  if (bodyQueue.length >= BODY_QUEUE_MAX) return false;
  bodyQueue.push({ post_id: record.post_id, permalink: record.permalink });
  return true;
}

function scheduleBodyDrain(): void {
  if (bodyBusy || bodyTimer !== null) return;
  bodyTimer = setTimeout(() => {
    bodyTimer = null;
    void drainBodyQueue();
  }, 2000);
}

function enqueueBodyFetch(records: ObservationRecord[]): void {
  const added = records.some((record) => admitBodyItem(record));
  if (added) scheduleBodyDrain();
}

async function drainBodyQueue(): Promise<void> {
  if (bodyBusy) return;
  bodyBusy = true;
  try {
    while (bodyQueue.length > 0) {
      if (bodyQueuePaused) {
        await sleep(1000);
        continue;
      }
      const item = bodyQueue.shift();
      if (!item) break;
      await fetchPostBody(item);
      await sleep(BODY_FETCH_DELAY_MS);
    }
  } finally {
    bodyBusy = false;
  }
}

/** A 403/404 means the post is gone; re-429 means try again later. */
function handleBodyFetchStatus(item: BodyItem, status: number): 'retry' | 'gone' | 'ok' {
  if (status === 429) return 'retry';
  if (status === 403 || status === 404) {
    bodyFailed.add(item.post_id);
    void swLog({ event: 'body-fetch-gone', post_id: item.post_id, status });
    return 'gone';
  }
  return 'ok';
}

async function fetchPostBody(item: BodyItem): Promise<void> {
  const url = `https://www.reddit.com${item.permalink.replace(/\/+$/, '')}.json?limit=50&raw_json=1`;
  try {
    const response = await redditFetch(url);
    const state = handleBodyFetchStatus(item, response.status);
    if (state === 'retry') bodyQueue.unshift(item);
    if (state !== 'ok') return;
    const payload: unknown = await response.json();
    const record = recordFromApiPost(firstPostEntry(payload), {
      capturedAtMs: Date.now(),
      sourceEndpoint: '/api/enrich',
    });
    if (record?.selftext === undefined) {
      bodyFailed.add(item.post_id);
      return;
    }
    await enrichWithBody(item, record);
  } catch (error) {
    void swLog({
      event: 'body-fetch-failed',
      post_id: item.post_id,
      error: String((error as Error | undefined)?.message ?? error).slice(0, 120),
    });
  }
}

/** Enrich a bodyless record and route it through the capture path. */
async function enrichWithBody(item: BodyItem, record: PostRecord): Promise<void> {
  const observation = await recordObservation(record);
  if (observation !== null) ingestStored([observation]);
  void swLog({ event: 'body-enriched', post_id: item.post_id });
}

function firstPostEntry(payload: unknown): unknown {
  const arr = Array.isArray(payload) ? payload : [];
  const first = arr[0] as { data?: { children?: { kind?: unknown; data?: unknown }[] } } | undefined;
  const child = first?.data?.children?.find((c) => c.kind === 't3');
  return child?.data;
}

// One-shot DOM probe of the attached feed tab: how is reddit's logged-out
// join wall actually dismissable? Reported through the telemetry heartbeat.
async function probeWall(): Promise<Record<string, unknown>> {
  try {
    const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve, reject) => {
      chrome.debugger.getTargets((t) => {
        if (chrome.runtime.lastError !== undefined) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      });
    });
    const tab = targets.find((t) => t.attached && t.tabId !== undefined && t.url.includes('reddit.com'));
    if (tab?.tabId === undefined) return { attached: false };
    const reply = (await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'Runtime.evaluate', {
      returnByValue: true,
      expression: WALL_PROBE_EXPRESSION,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return { attached: true, raw: reply.result?.value };
  } catch (error) {
    return { error: String((error as Error | undefined)?.message ?? error).slice(0, 140) };
  }
}

const WALL_PROBE_EXPRESSION = `(async () => {
  const visible = (el) => el.checkVisibility?.() === true;
  const closeBtns = [...document.querySelectorAll('button')]
    .filter((b) => visible(b) && /close|dismiss/i.test((b.getAttribute('aria-label') ?? '') + ' ' + (b.getAttribute('title') ?? '')))
    .map((b) => ({ label: b.getAttribute('aria-label'), title: b.getAttribute('title'), html: b.outerHTML.slice(0, 140) }));
  const modal = [...document.querySelectorAll('div, section')]
    .filter((d) => d.textContent?.includes('Join the most real place'))
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
})()`;

const CaptureMessageSchema = z.looseObject({
  type: z.literal('redtap:capture'),
  records: z.array(PostRecordSchema).default([]),
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  const parsed = CaptureMessageSchema.safeParse(rawMessage);
  if (!parsed.success) return;
  captureMessages += 1;
  storeRecords(parsed.data.records)
    .then((stored) => {
      capturesStored += stored.length;
      ingestStored(stored);
      sendResponse({ stored: stored.length });
    })
    .catch(() => {
      sendResponse({ stored: 0 });
    });
  return true;
});

const PoolMessageSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('redtap:pool-config'),
    config: z
      .object({
        bucketRepo: z.string().optional(),
        hubToken: z.string().optional(),
        poolPaused: z.boolean().optional(),
        subs: z.array(z.string()).optional(),
      })
      .default({}),
    flushNow: z.boolean().optional(),
  }),
  z.looseObject({ type: z.literal('redtap:pool-status') }),
  z.looseObject({ type: z.literal('redtap:listing-backfill-now') }),
  z.looseObject({ type: z.literal('redtap:pool-flush-now') }),
  z.looseObject({ type: z.literal('redtap:export'), uniqueOnly: z.boolean().optional() }),
]);

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  const parsed = PoolMessageSchema.safeParse(rawMessage);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === 'redtap:pool-config') {
    setConfig(message.config, message.flushNow === true);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'redtap:pool-status') {
    void chrome.storage.local.get('swLog').then((bag) => {
      sendResponse({
        ...statusSnapshot(),
        listing: { ...listingState },
        captureMessages,
        capturesStored,
        swLog: ((bag.swLog as Record<string, unknown>[] | undefined) ?? []).slice(-6),
      });
    });
    return true;
  }
  if (message.type === 'redtap:listing-backfill-now') {
    runListingBackfill()
      .then(() => {
        sendResponse({ ok: true, listing: { ...listingState } });
      })
      .catch(() => {
        sendResponse({ ok: false, listing: { ...listingState } });
      });
    return true;
  }
  if (message.type === 'redtap:pool-flush-now') {
    flushNowNow()
      .then((n) => {
        sendResponse({ flushed: n });
      })
      .catch(() => {
        sendResponse({ flushed: 0 });
      });
    return true;
  }
  // redtap:export — local exports are gone; the bucket's v1 log is the data path.
  sendResponse({ exported: 0 });
  return true;
});
