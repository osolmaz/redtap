// v2 segment format: bodies (selftext) stored once per hash, sightings as
// small lines carrying their own metadata plus the body hash.
//
//   {"k":"body","h":"<sha256 of selftext>","selftext":"..."}
//   {"k":"sight","oid":...,"post_id":...,"t":<captured_at>,"src":...,"by":...,
//    "h":"<selftext hash or EMPTY_BODY_HASH>","post_at":...,"title":...,...}
//
// The reader expands sights back into v1-shaped observation records so the
// Space's summarize() works unchanged. Pure module: no chrome or node
// imports; the digest function is injected (crypto.subtle in the worker,
// node:crypto in the builder).

const SIGHT_FIELDS = ['post_at', 'title', 'author', 'subreddit', 'permalink', 'content_href', 'thumb_href', 'post_type'];

/** Empty-body marker: the sha256 of the empty string. */
export const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function selftextOf(record) {
  const t = record.selftext;
  return typeof t === 'string' && t.length > 0 && t !== '[removed]' && t !== '[deleted]' ? t : '';
}

/** Hex sha256 of the record's selftext using the injected digest implementation. */
export async function bodyHash(record, digest) {
  const text = selftextOf(record);
  if (text === '') return EMPTY_BODY_HASH;
  return digest(new TextEncoder().encode(text));
}

/** A body line: the selftext blob, written at most once per hash. */
export function bodyLine(record, hash) {
  return { k: 'body', h: hash, selftext: selftextOf(record) };
}

/** A sight line: the observation identity, metrics, and inline metadata. */
export function sightLine(record, hash) {
  const m = record.metrics ?? {};
  const line = {
    k: 'sight',
    oid: record.observation_id,
    post_id: record.post_id,
    t: record.captured_at,
    src: record.source_endpoint ?? '/api/tap',
    by: record.contributed_by ?? 'tap',
    h: hash,
  };
  if (record.pooled_at !== null && record.pooled_at !== undefined) line.pooled_at = record.pooled_at;
  for (const key of SIGHT_FIELDS) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') line[key] = value;
  }
  if (m.score !== null && m.score !== undefined) line.score = m.score;
  if (m.comments !== null && m.comments !== undefined) line.comments = m.comments;
  if (m.upvote_ratio !== null && m.upvote_ratio !== undefined) line.ratio = m.upvote_ratio;
  return line;
}

/** Split records into v2 lines: one body line per unseen selftext hash,
 *  a sight per record. knownHashes: hashes committed in earlier segments;
 *  callers add newly seen hashes only after a successful commit. */
export async function toV2Lines(records, knownHashes, digest) {
  const lines = [];
  const emitted = new Set();
  for (const record of records) {
    if (!record?.post_id || !record?.observation_id) continue;
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
export function hashesOf(lines) {
  const out = new Set();
  for (const line of lines) if (line.k === 'body') out.add(line.h);
  return out;
}

/** Expand v2 lines back into v1-shaped observation records. */
export function fromV2Lines(lines) {
  const bodies = new Map();
  const records = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    if (line.k === 'body') {
      bodies.set(line.h, line);
      continue;
    }
    if (line.k !== 'sight') continue;
    const metrics = {};
    if (line.score !== undefined) metrics.score = line.score;
    if (line.comments !== undefined) metrics.comments = line.comments;
    if (line.ratio !== undefined) metrics.upvote_ratio = line.ratio;
    const record = {
      observation_id: line.oid,
      post_id: line.post_id,
      post_at: line.post_at ?? null,
      captured_at: line.t,
      source_endpoint: line.src,
      contributed_by: line.by,
      pooled_at: line.pooled_at ?? null,
      title: line.title ?? null,
      author: line.author ?? null,
      subreddit: line.subreddit ?? null,
      permalink: line.permalink ?? '',
      content_href: line.content_href ?? null,
      thumb_href: line.thumb_href ?? null,
      post_type: line.post_type ?? null,
      metrics,
    };
    if (line.h !== EMPTY_BODY_HASH) {
      const body = bodies.get(line.h);
      if (body) record.selftext = body.selftext;
    }
    records.push(record);
  }
  return records;
}

/** Parse raw JSONL text into line objects, skipping malformed lines. */
export function parseV2Text(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {}
  }
  return lines;
}
