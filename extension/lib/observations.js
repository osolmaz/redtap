// Observation identities and sampling, modeled on xTap's lib/observations.js.
//
// A redtap observation is one (post, content-revision, surface) sighting.
// The observation id is a stable content hash so the same post seen again with
// unchanged content maps to the same id; the unique-post export filter is
// independent of observation identity and keeps only the first sighting of
// each post id. Unchanged re-observations are sampled at SAMPLE_INTERVAL_MS.

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
export function exactCounter(value) {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Canonical JSON: sorted keys, no undefined, stable across runs. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const parts = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item));
  return '{' + parts.join(',') + '}';
}

export async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable observation identity for a captured post record.
 * Transport fields are excluded so re-sightings hash the same.
 */
export async function observationId(record) {
  const payload = {};
  for (const [key, value] of Object.entries(record)) {
    if (!OBSERVATION_TRANSPORT_FIELDS.has(key)) payload[key] = value;
  }
  const full = await digest(payload);
  return 'rt_' + full.slice(0, 24);
}

/** True when an unchanged re-observation should be stored (sampling gate). */
export function shouldSampleUnchanged(lastSeenAtMs, nowMs, intervalMs = SAMPLE_INTERVAL_MS) {
  if (typeof lastSeenAtMs !== 'number' || !(lastSeenAtMs >= 0)) return true;
  return nowMs - lastSeenAtMs >= intervalMs;
}

/** Extract the normalized post record from a shreddit-post element. */
export function extractPostRecord(element, context = {}) {
  if (!element || element.tagName?.toLowerCase() !== 'shreddit-post') return null;
  const attr = (name) => element.getAttribute?.(name) ?? null;
  const id = attr('id');
  const permalink = attr('permalink');
  if (!id || !permalink) return null;
  const score = exactCounter(attr('score'));
  const comments = exactCounter(attr('comment-count'));
  const ratioRaw = attr('upvote-ratio');
  const ratio = ratioRaw === null ? null : Number(ratioRaw);
  const sourceEndpoint = context.sourceEndpoint ?? new URL(element.ownerDocument?.URL ?? 'https://reddit.com').pathname;
  return {
    post_id: id,
    post_at: attr('created-timestamp'),
    captured_at: context.capturedAtMs ?? Date.now(),
    source_endpoint: sourceEndpoint,
    contributed_by: 'local',
    pooled_at: null,
    title: attr('post-title'),
    author: attr('author'),
    author_id: attr('author-id'),
    subreddit: attr('subreddit-prefixed-name'),
    subreddit_id: attr('subreddit-id'),
    permalink,
    post_type: attr('post-type'),
    domain: attr('domain'),
    content_href: attr('content-href'),
    view_context: attr('view-context'),
    award_count: exactCounter(attr('award-count')),
    metrics: { score, comments, upvote_ratio: Number.isFinite(ratio) ? ratio : null },
  };
}

/** Unique-post export filter key. */
export function postKey(record) {
  return record?.post_id ? String(record.post_id) : null;
}
