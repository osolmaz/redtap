// v1 segment format: bodies (selftext) stored once per hash, sightings as
// small lines carrying their own metadata plus the body hash.
//
//   {"k":"body","h":"<sha256 of selftext>","selftext":"..."}
//   {"k":"sight","oid":...,"post_id":...,"t":<captured_at>,"src":...,"by":...,
//    "h":"<selftext hash or EMPTY_BODY_HASH>","post_at":...,"title":...,...}
//
// The reader expands sights back into observation records so the summarize()
// path works unchanged. Pure module: no chrome or node imports; the digest
// function is injected (crypto.subtle in the worker, node:crypto in the
// builder).

import {
  BodyLineSchema,
  EMPTY_BODY_HASH,
  ObservationRecordSchema,
  SightLineSchema,
  V1LineSchema,
  type BodyLine,
  type ObservationRecord,
  type SightLine,
  type V1Line,
} from './schema.ts';

export { EMPTY_BODY_HASH };
export type { BodyLine, ObservationRecord, SightLine, V1Line };

/** Digest function injected by the caller: hex sha256 of bytes. */
export type Digest = (bytes: Uint8Array) => Promise<string>;

const SIGHT_FIELDS = [
  'post_at',
  'title',
  'author',
  'subreddit',
  'permalink',
  'content_href',
  'thumb_href',
  'post_type',
] as const;

const NULL_BODY_PLACEHOLDERS = ['[removed]', '[deleted]'];

/** Body text worth storing: non-empty and not a reddit placeholder. */
export function selftextOf(record: ObservationRecord): string {
  const t = record.selftext;
  if (t === undefined || t.length === 0) return '';
  return NULL_BODY_PLACEHOLDERS.includes(t) ? '' : t;
}

/** Hex sha256 of the record's selftext using the injected digest implementation. */
export async function bodyHash(record: ObservationRecord, digest: Digest): Promise<string> {
  const text = selftextOf(record);
  if (text === '') return EMPTY_BODY_HASH;
  return digest(new TextEncoder().encode(text));
}

export function bodyLine(record: ObservationRecord, hash: string): BodyLine {
  return BodyLineSchema.parse({ k: 'body', h: hash, selftext: selftextOf(record) });
}

/** Copy a record field onto the sight line when it carries information. */
function applySightField(
  line: SightLine,
  record: ObservationRecord,
  key: (typeof SIGHT_FIELDS)[number],
): void {
  const value = record[key];
  if (value === undefined || value === null || value === '') return;
  (line as Record<string, unknown>)[key] = value;
}

/** Copy a metric onto the sight line when it is known. */
function applyMetric(line: SightLine, metric: number | null, key: 'score' | 'comments' | 'ratio'): void {
  if (metric === null) return;
  (line as Record<string, unknown>)[key] = metric;
}

export function sightLine(record: ObservationRecord, hash: string): SightLine {
  const m = record.metrics;
  const line: SightLine = {
    k: 'sight',
    oid: record.observation_id,
    post_id: record.post_id,
    t: record.captured_at,
    src: record.source_endpoint,
    by: record.contributed_by,
    h: hash,
  };
  if (record.pooled_at !== null) line.pooled_at = record.pooled_at;
  for (const key of SIGHT_FIELDS) applySightField(line, record, key);
  applyMetric(line, m.score, 'score');
  applyMetric(line, m.comments, 'comments');
  applyMetric(line, m.upvote_ratio, 'ratio');
  return SightLineSchema.parse(line);
}

/** Split records into v1 lines: one body line per unseen selftext hash,
 * a sight per record. knownHashes: hashes committed in earlier segments;
 * callers add newly seen hashes only after a successful commit. */
export async function toV1Lines(
  records: ObservationRecord[],
  knownHashes: Set<string>,
  digest: Digest,
): Promise<V1Line[]> {
  const lines: V1Line[] = [];
  const emitted = new Set<string>();
  for (const raw of records) {
    const record = ObservationRecordSchema.parse(raw);
    if (record.post_id === '' || record.observation_id === '') continue;
    const h = await bodyHash(record, digest);
    if (h !== EMPTY_BODY_HASH && !knownHashes.has(h) && !emitted.has(h)) {
      emitted.add(h);
      lines.push(bodyLine(record, h));
    }
    lines.push(sightLine(record, h));
  }
  return lines;
}

/** The hashes a batch introduced (add these to knownHashes only after commit). */
export function hashesOf(lines: V1Line[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) if (line.k === 'body') out.add(line.h);
  return out;
}

type Accumulator = {
  bodies: Map<string, BodyLine>;
  records: ObservationRecord[];
};

/** `value ?? fallback` with a narrow signature the lint rules can verify. */
function defined<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

/** Attach the stored body for a sight that references one. */
function attachBody(acc: Accumulator, record: ObservationRecord, hash: string): void {
  if (hash === EMPTY_BODY_HASH) return;
  const body = acc.bodies.get(hash);
  if (body !== undefined) record.selftext = body.selftext;
}

function acceptSight(acc: Accumulator, line: SightLine): void {
  const metrics = {
    score: defined(line.score, null),
    comments: defined(line.comments, null),
    upvote_ratio: defined(line.ratio, null),
  };
  const record: ObservationRecord = {
    observation_id: line.oid,
    post_id: line.post_id,
    post_at: defined(line.post_at, null),
    captured_at: line.t,
    source_endpoint: line.src,
    contributed_by: line.by,
    pooled_at: defined(line.pooled_at, null),
    title: defined(line.title, null),
    author: defined(line.author, null),
    subreddit: defined(line.subreddit, null),
    permalink: defined(line.permalink, ''),
    content_href: defined(line.content_href, null),
    thumb_href: defined(line.thumb_href, null),
    post_type: defined(line.post_type, null),
    metrics,
  };
  attachBody(acc, record, line.h);
  acc.records.push(record);
}

/** Expand v1 lines back into observation records; malformed lines are skipped. */
export function fromV1Lines(lines: unknown[]): ObservationRecord[] {
  const acc: Accumulator = { bodies: new Map(), records: [] };
  for (const entry of lines) {
    const parsed = V1LineSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (parsed.data.k === 'body') acc.bodies.set(parsed.data.h, parsed.data);
    else acceptSight(acc, parsed.data);
  }
  return acc.records;
}

/** Parse raw JSONL text into line objects, skipping malformed lines. */
export function parseV1Text(text: string): V1Line[] {
  const lines: V1Line[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed = V1LineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
    } catch {
      // not JSON: skip the line
    }
  }
  return lines;
}
