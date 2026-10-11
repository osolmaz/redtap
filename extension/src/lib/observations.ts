// Observation identities and sampling, modeled on xTap's lib/observations.js.
//
// A redtap observation is one (post, content-revision, surface) sighting.
// The observation id is a stable content hash so the same post seen again with
// unchanged content maps to the same id; the unique-post export filter is
// independent of observation identity and keeps only the first sighting of
// each post id. Unchanged re-observations are sampled at SAMPLE_INTERVAL_MS.

import { z } from 'zod';
import type { PostRecord } from './schema.ts';
import { ApiPostEntrySchema } from './schema.ts';

export const SAMPLE_INTERVAL_MS = 5 * 60_000;
export const MAX_SAMPLES = 50_000;

export const OBSERVATION_TRANSPORT_FIELDS = new Set([
  'captured_at',
  'pooled_at',
  'contributed_by',
  'source_endpoint',
  'observation_id',
]);

/** Exact counter from a shreddit attribute: digits or null. */
export function exactCounter(value: string | null | undefined): number | null {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Canonical JSON: sorted keys, no undefined, stable across runs. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item));
  return '{' + parts.join(',') + '}';
}

export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable observation identity: transport fields excluded so re-sightings hash the same. */
export async function observationId(record: Record<string, unknown>): Promise<string> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!OBSERVATION_TRANSPORT_FIELDS.has(key)) payload[key] = value;
  }
  const full = await digest(payload);
  return 'rt_' + full.slice(0, 24);
}

/** True when an unchanged re-observation should be stored (sampling gate). */
export function shouldSampleUnchanged(
  lastSeenAtMs: unknown,
  nowMs: number,
  intervalMs: number = SAMPLE_INTERVAL_MS,
): boolean {
  if (typeof lastSeenAtMs !== 'number' || !(lastSeenAtMs >= 0)) return true;
  return nowMs - lastSeenAtMs >= intervalMs;
}

/** Normalize Reddit's timestamp attribute into a stable ISO string. */
export function parseTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The slice of the shreddit-post element the extractor reads. Structural so
 * tests can feed plain objects; real DOM elements satisfy it. */
export type PostElement = {
  tagName: string;
  ownerDocument?: { URL: string };
  getAttribute?: (name: string) => string | null;
  querySelector?: (selector: string) => { textContent?: string } | null;
};

const REMOVED_BODIES = new Set(['[removed]', '[deleted]']);

function cleanSelftext(text: string): string | null {
  const cleaned = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 0 && !REMOVED_BODIES.has(cleaned) ? cleaned.slice(0, 20_000) : null;
}

/** Body text from a rendered post page or rich feed preview, if present. */
export function extractSelftext(element: PostElement | null | undefined): string | null {
  const body = element?.querySelector?.('[slot="text-body"]')?.textContent ?? '';
  // Collapse runs of spaces but keep line breaks: markdown structure lives in them.
  const cleaned =
    cleanSelftext(
      body
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    ) ?? '';
  return cleaned.length > 0 ? cleaned : null;
}

function isPostElement(element: PostElement | null | undefined): boolean {
  return element?.tagName.toLowerCase() === 'shreddit-post';
}

/** DOM attributes that map straight onto record fields. */
const ATTRIBUTE_FIELDS = [
  'post-title',
  'author',
  'author-id',
  'subreddit-prefixed-name',
  'subreddit-id',
  'post-type',
  'domain',
  'content-href',
  'view-context',
] as const;

type RecordField =
  | 'title'
  | 'author'
  | 'author_id'
  | 'subreddit'
  | 'subreddit_id'
  | 'post_type'
  | 'domain'
  | 'content_href'
  | 'view_context';

const ATTRIBUTE_TO_FIELD: Record<(typeof ATTRIBUTE_FIELDS)[number], RecordField> = {
  'post-title': 'title',
  author: 'author',
  'author-id': 'author_id',
  'subreddit-prefixed-name': 'subreddit',
  'subreddit-id': 'subreddit_id',
  'post-type': 'post_type',
  domain: 'domain',
  'content-href': 'content_href',
  'view-context': 'view_context',
};

function applyAttributes(record: PostRecord, attr: (name: string) => string | null): void {
  for (const attribute of ATTRIBUTE_FIELDS) {
    record[ATTRIBUTE_TO_FIELD[attribute]] = attr(attribute);
  }
}

function applyAttributeMetrics(record: PostRecord, attr: (name: string) => string | null): void {
  const ratioRaw = attr('upvote-ratio');
  const ratio = ratioRaw === null ? null : Number(ratioRaw);
  record.metrics = {
    score: exactCounter(attr('score')),
    comments: exactCounter(attr('comment-count')),
    upvote_ratio: Number.isFinite(ratio) ? ratio : null,
  };
  record.award_count = exactCounter(attr('award-count'));
}

/** Extract the normalized post record from a shreddit-post element. */
// eslint-disable-next-line complexity -- flat field-copy boundary: each branch is a source-field fallback, not a decision
export function extractPostRecord(
  element: PostElement | null | undefined,
  context: { capturedAtMs?: number; sourceEndpoint?: string } = {},
): PostRecord | null {
  if (!isPostElement(element) || element === null || element === undefined) return null;
  const el = element;
  const attr = (name: string): string | null => el.getAttribute?.(name) ?? null;
  const id = attr('id');
  const permalink = attr('permalink');
  if (id === null || id === '' || permalink === null || permalink === '') return null;
  const documentUrl = el.ownerDocument?.URL;
  const sourceEndpoint = context.sourceEndpoint ?? new URL(documentUrl ?? 'https://reddit.com').pathname;
  const record: PostRecord = {
    post_id: id,
    post_at: parseTimestamp(attr('created-timestamp')),
    captured_at: context.capturedAtMs ?? Date.now(),
    source_endpoint: sourceEndpoint,
    contributed_by: 'local',
    pooled_at: null,
    title: null,
    author: null,
    subreddit: null,
    permalink,
    content_href: null,
    metrics: { score: null, comments: null, upvote_ratio: null },
  };
  applyAttributes(record, attr);
  applyAttributeMetrics(record, attr);
  const selftext = extractSelftext(el);
  if (selftext !== null) record.selftext = selftext;
  return record;
}

const num = (value: number | undefined): number | null => value ?? null;

/** Normalize a validated Reddit API t3 entry into an observation record. */
// eslint-disable-next-line complexity -- flat field-copy boundary: each branch is a source-field fallback, not a decision
function recordFromApiEntry(
  entry: z.infer<typeof ApiPostEntrySchema>,
  context: { capturedAtMs?: number; sourceEndpoint?: string },
): PostRecord {
  const id = entry.id.startsWith('t3_') ? entry.id : 't3_' + entry.id;
  const permalink = entry.permalink ?? '';
  const createdMs = entry.created_utc === undefined ? null : entry.created_utc * 1000;
  const isSelf = entry.is_self === true;
  const selftext = entry.selftext === undefined ? null : cleanSelftext(entry.selftext);
  const record: PostRecord = {
    post_id: id,
    post_at: createdMs === null ? null : new Date(createdMs).toISOString(),
    captured_at: context.capturedAtMs ?? Date.now(),
    source_endpoint: context.sourceEndpoint ?? '/api/tap',
    contributed_by: 'tap',
    pooled_at: null,
    title: entry.title ?? null,
    author: entry.author === undefined || entry.author === '[deleted]' ? null : entry.author,
    author_id: entry.author_fullname ?? null,
    subreddit: entry.subreddit_name_prefixed ?? null,
    subreddit_id: entry.subreddit_id ?? null,
    permalink,
    post_type: isSelf && entry.post_hint === undefined ? 'self' : (entry.post_hint ?? null),
    domain: entry.domain ?? null,
    content_href: entry.url_overridden_by_dest ?? (isSelf ? permalink : null),
    thumb_href: entry.thumbnail?.startsWith('http') === true ? entry.thumbnail : null,
    view_context: null,
    award_count: num(entry.total_awards_received),
    metrics: {
      score: num(entry.score),
      comments: num(entry.num_comments),
      upvote_ratio: num(entry.upvote_ratio),
    },
  };
  if (selftext !== null) record.selftext = selftext;
  return record;
}

/** Normalized post record from a Reddit API (t3) entry, same shape as DOM captures. */
export function recordFromApiPost(
  entry: unknown,
  context: { capturedAtMs?: number; sourceEndpoint?: string } = {},
): PostRecord | null {
  const parsed = ApiPostEntrySchema.safeParse(entry);
  if (!parsed.success || parsed.data.permalink === undefined) return null;
  return recordFromApiEntry(parsed.data, context);
}

/** Walk a Reddit API payload and return every normalized post it carries. */
export function postsFromApiPayload(
  payload: unknown,
  context: { capturedAtMs?: number; sourceEndpoint?: string } = {},
): PostRecord[] {
  const records: PostRecord[] = [];
  const seen = new Set<string>();
  visitApiNode(payload, context, records, seen);
  return records;
}

function acceptApiPost(
  node: Record<string, unknown>,
  context: { capturedAtMs?: number; sourceEndpoint?: string },
  records: PostRecord[],
  seen: Set<string>,
): void {
  const record = recordFromApiPost(node.data, context);
  if (record === null || seen.has(record.post_id)) return;
  seen.add(record.post_id);
  records.push(record);
}

function visitApiNode(
  node: unknown,
  context: { capturedAtMs?: number; sourceEndpoint?: string },
  records: PostRecord[],
  seen: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visitApiNode(item, context, records, seen);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.kind === 't3' && obj.data) {
    acceptApiPost(obj, context, records, seen);
    return;
  }
  for (const value of Object.values(obj)) visitApiNode(value, context, records, seen);
}

/** Unique-post export filter key. */
export function postKey(record: PostRecord | null | undefined): string | null {
  if (record?.post_id === undefined || record.post_id === '') return null;
  return record.post_id;
}
