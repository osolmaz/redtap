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

/** Normalize Reddit's timestamp attribute into a stable ISO string. */
export function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Body text from a rendered post page or rich feed preview, if present. */
export function extractSelftext(element) {
  const body = element?.querySelector?.('[slot="text-body"]')?.textContent ?? '';
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 20_000) : null;
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
  const record = {
    post_id: id,
    post_at: parseTimestamp(attr('created-timestamp')),
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
  const selftext = extractSelftext(element);
  if (selftext) record.selftext = selftext;
  return record;
}

/** Normalized post record from a Reddit API (t3) entry, same shape as DOM captures. */
export function recordFromApiPost(entry, context = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const rawId = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null;
  const id = rawId === null ? null : (rawId.startsWith('t3_') ? rawId : 't3_' + rawId);
  const permalink = typeof entry.permalink === 'string' && entry.permalink.length > 0 ? entry.permalink : null;
  if (!id || !permalink) return null;
  const createdMs = typeof entry.created_utc === 'number' && Number.isFinite(entry.created_utc) ? entry.created_utc * 1000 : null;
  const selftext = typeof entry.selftext === 'string' ? entry.selftext.replace(/\s+/g, ' ').trim().slice(0, 20_000) : '';
  const hasBody = selftext.length > 0 && selftext !== '[removed]' && selftext !== '[deleted]';
  const record = {
    post_id: id,
    post_at: createdMs === null ? null : new Date(createdMs).toISOString(),
    captured_at: context.capturedAtMs ?? Date.now(),
    source_endpoint: context.sourceEndpoint ?? '/api/tap',
    contributed_by: 'tap',
    pooled_at: null,
    title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : null,
    author: typeof entry.author === 'string' && entry.author !== '[deleted]' ? entry.author : null,
    author_id: typeof entry.author_fullname === 'string' ? entry.author_fullname : null,
    subreddit: typeof entry.subreddit_name_prefixed === 'string' ? entry.subreddit_name_prefixed : null,
    subreddit_id: typeof entry.subreddit_id === 'string' && entry.subreddit_id.length > 0 ? entry.subreddit_id : null,
    permalink,
    post_type: entry.is_self === true ? 'self' : entry.post_hint ?? null,
    domain: typeof entry.domain === 'string' ? entry.domain : null,
    content_href: typeof entry.url_overridden_by_dest === 'string' ? entry.url_overridden_by_dest : (entry.is_self === true ? permalink : null),
    view_context: null,
    award_count: typeof entry.total_awards_received === 'number' ? entry.total_awards_received : null,
    metrics: {
      score: typeof entry.score === 'number' ? entry.score : null,
      comments: typeof entry.num_comments === 'number' ? entry.num_comments : null,
      upvote_ratio: typeof entry.upvote_ratio === 'number' ? entry.upvote_ratio : null,
    },
  };
  if (hasBody) record.selftext = selftext;
  return record;
}

/** Walk a Reddit API payload and return every normalized post it carries. */
export function postsFromApiPayload(payload, context = {}) {
  const records = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.kind === 't3' && node.data) {
      const record = recordFromApiPost(node.data, context);
      if (record && !seen.has(record.post_id)) {
        seen.add(record.post_id);
        records.push(record);
      }
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(payload);
  return records;
}

/** Unique-post export filter key. */
export function postKey(record) {
  return record?.post_id ? String(record.post_id) : null;
}
