// Shared store + render path for redtap serving.
//
// build-site.mjs (static pre-render for Pages) and serve.mjs (local server)
// both go through this module, so the two never fork the renderer: the same
// renderRoute() powers every route, and the same readV1Lines() powers both
// storage backends (HF bucket or a local folder).

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles, downloadFile } from '@huggingface/hub';
import { fromV1Lines } from '../extension/lib/v1log.js';
import { renderBrowsePage, renderPostPage } from '../space/src/browse.ts';
import { renderRss } from '../space/src/rss.ts';

export const SORTS = ['hot', 'new', 'top', 'rising'];
export const RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];
export const DEFAULT_BUCKET = 'osolmaz/redtap-data';

export function withBase(html, base) {
  if (!base) return html;
  // prefix every root-relative link and form target so the same html serves
  // at a subpath
  return html.replaceAll('href="/', 'href="' + base + '/').replaceAll('action="/', 'action="' + base + '/');
}

/** Parse one v1 segment (gzipped or plain JSONL) into line objects. */
export function parseSegment(rel, bytes) {
  const text = rel.endsWith('.gz') ? gunzipSync(bytes).toString('utf-8') : bytes.toString('utf-8');
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch {}
  }
  return lines;
}

function walkJsonl(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (/\.jsonl(\.gz)?$/.test(entry.name)) out.push(p);
  }
}

/** All v1 segment paths under a local bucket-root mirror (a folder holding v1/log/…,
 *  or directly the segment folder). Sorted for a deterministic read order. */
export function listLocalSegments(dir) {
  let base = dir;
  try {
    readdirSync(join(dir, 'v1', 'log'));
    base = join(dir, 'v1', 'log'); // a bucket-root mirror with v1/log inside
  } catch { /* dir itself is the segment folder */ }
  const out = [];
  walkJsonl(base, out);
  return out.sort();
}

/** Read every v1 segment line from a backend.
 *  - {kind:'local', dir}    a folder mirroring the bucket layout (or the log folder itself)
 *  - {kind:'hf', repo, token}   the private HF bucket via @huggingface/hub */
export async function readV1Lines(source) {
  if (source.kind === 'local') {
    const paths = listLocalSegments(source.dir);
    console.error('v1 segments:', paths.length);
    const lines = [];
    for (const path of paths) {
      lines.push(...parseSegment(path, readFileSync(path)));
    }
    return lines;
  }
  // hub wants a typed repo object for buckets
  const hubRepo = typeof source.repo === 'string' ? { type: 'bucket', name: source.repo } : source.repo;
  const paths = [];
  for await (const entry of listFiles({ repo: hubRepo, accessToken: source.token, recursive: true, path: 'v1/log/', expand: false })) {
    if (typeof entry === 'object' && 'path' in entry) {
      const p = String(entry.path);
      if (p.endsWith('.jsonl.gz') || p.endsWith('.jsonl')) paths.push(p);
    }
  }
  paths.sort();
  console.error('v1 segments:', paths.length);
  const lines = [];
  for (const path of paths) {
    for (let attempt = 1; ; attempt++) {
      try {
        const blob = await downloadFile({ repo: hubRepo, accessToken: source.token, path, xet: false });
        if (!blob) break;
        lines.push(...parseSegment(path, Buffer.from(await blob.arrayBuffer())));
        break;
      } catch (error) {
        if (attempt >= 4) { console.error('giving up on', path, String(error?.message ?? error).slice(0, 100)); break; }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return lines;
}

// Reddit was founded in June 2005; anything earlier is a bad parse (same
// sanity window as the Space's postDateMs).
const MIN_SANE_POST_MS = Date.parse('2005-06-01T00:00:00.000Z');

/** Group deduped records into PostSummaries (the Space's record-store shape). */
export function buildSummaries(unique) {
  const byPost = new Map();
  for (const r of unique) {
    const list = byPost.get(r.post_id) ?? [];
    list.push(r);
    byPost.set(r.post_id, list);
  }
  for (const list of byPost.values()) list.sort((a, b) => a.captured_at - b.captured_at);
  const out = [...byPost.entries()].map(([post_id, sightings]) => {
    const first = sightings[0];
    const last = sightings[sightings.length - 1];
    const sf = first.metrics?.score ?? null;
    const sl = last.metrics?.score ?? null;
    const cf = first.metrics?.comments ?? null;
    const cl = last.metrics?.comments ?? null;
    // skip unparseable or out-of-bounds post_at values and keep scanning,
    // like the Space's postDateMs
    const ceiling = Date.now() + 86_400_000;
    let postAtMs = null;
    for (const s of sightings) {
      if (typeof s.post_at !== 'string' || s.post_at.length === 0) continue;
      const ms = Date.parse(s.post_at);
      if (!Number.isFinite(ms) || ms < MIN_SANE_POST_MS || ms > ceiling) continue;
      postAtMs = ms;
      break;
    }
    return {
      post_id,
      subreddit: last.subreddit ?? first.subreddit ?? null,
      title: last.title ?? first.title ?? null,
      author: last.author ?? first.author ?? null,
      permalink: last.permalink ?? first.permalink ?? '',
      content_href: last.content_href ?? first.content_href ?? null,
      thumb_href: last.thumb_href ?? first.thumb_href ?? null,
      post_type: last.post_type ?? first.post_type ?? null,
      post_at: postAtMs,
      first_seen: first.captured_at,
      last_seen: last.captured_at,
      observations: sightings.length,
      score_first: sf,
      score_last: sl,
      score_delta: sf !== null && sl !== null ? sl - sf : null,
      comments_last: cl,
      comments_delta: cf !== null && cl !== null ? cl - cf : null,
      selftext: [...sightings].reverse().map((r) => r.selftext).find((t) => typeof t === 'string' && t.length > 0) ?? null,
    };
  });
  out.sort((a, b) => a.post_id.localeCompare(b.post_id));
  return { summaries: out, byPost };
}

/** Build the full render state from a backend source. */
export async function siteState(source, opts = {}) {
  const lines = await readV1Lines(source);
  const records = fromV1Lines(lines);
  console.error('records:', records.length);
  const { summaries, byPost } = buildSummaries(records);
  return { summaries, byPost, now: opts.now ?? Date.now(), base: opts.base ?? '', siteUrl: opts.siteUrl ?? '' };
}

/** UTC days that have posts (identical derivation in the builder and the server). */
export function dataDays(summaries) {
  return [...new Set(summaries.filter((p) => p.post_at).map((p) => new Date(p.post_at).toISOString().slice(0, 10)))].sort();
}

function subKey(sub) { return String(sub ?? '').replace(/^r\//i, ''); }

/** Every route the static builder writes, as output-relative paths. */
export function allRoutes(summaries) {
  const out = ['index.html'];
  for (const s of SORTS) out.push(`${s}/index.html`);
  for (const s of SORTS) for (const r of RANGES) out.push(`${s}/${r}/index.html`);
  const subs = [...new Set(summaries.map((p) => p.subreddit).filter(Boolean))];
  for (const sub of subs) {
    const subPath = 'r/' + subKey(sub);
    out.push(`${subPath}/index.html`);
    for (const s of SORTS) out.push(`${subPath}/${s}/index.html`);
    for (const s of SORTS) for (const r of RANGES) out.push(`${subPath}/${s}/${r}/index.html`);
  }
  for (const day of dataDays(summaries)) {
    for (const s of SORTS) out.push(`day/${day}/${s}/index.html`);
    out.push(`day/${day}/index.html`);
  }
  out.push('days/index.html');
  for (const summary of summaries) {
    const subPart = summary.subreddit ? 'r/' + subKey(summary.subreddit) + '/' : '';
    out.push(`${subPart}comments/${summary.post_id.replace(/^t3_/, '')}/index.html`);
  }
  out.push('rss.xml', 'status.json', 'index.json');
  return out;
}

function subredditByPath(state) {
  const map = new Map();
  for (const p of state.summaries) if (p.subreddit) map.set(subKey(p.subreddit), p.subreddit);
  return map;
}

function postByPath(state) {
  const map = new Map();
  for (const p of state.summaries) {
    const subPart = p.subreddit ? 'r/' + subKey(p.subreddit) + '/' : '';
    const id = p.post_id.replace(/^t3_/, '');
    map.set(`/${subPart}comments/${id}/`, p);
    map.set(`/comments/${id}/`, p); // short form also resolves
  }
  return map;
}

const cache = (state, key, build) => state[key] ?? (state[key] = build(state));

/** Resolve one route to rendered content. `pathname` accepts either a URL-style
 *  path ('/hot/day/', '/r/LocalLLaMA/comments/t3_x/') or an output-relative path
 *  ('hot/index.html', 'rss.xml'). Returns {body, type} or null when unknown. */
export function renderRoute(pathname, state, queryOverrides) {
  const { summaries, byPost, now, base = '', siteUrl = '' } = state;
  let p = String(pathname).replace(/^\/+/, '');
  if (p === 'index.html' || p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
  p = '/' + p;
  if (p.length > 1 && !p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p)) p += '/';

  if (p === '/status.json') {
    return { type: 'application/json', body: JSON.stringify({ newestSightingMs: Math.max(...summaries.map((x) => x.last_seen), 0), posts: summaries.length, builtAt: now }, null, 2) };
  }
  if (p === '/index.json') {
    return { type: 'application/json', body: JSON.stringify({ posts: summaries }, null, 1) };
  }
  if (p === '/rss.xml') {
    // rss.xml is the path the rendered pages link (autodiscovery + header)
    return { type: 'application/rss+xml', body: renderRss(summaries, siteUrl).replace('href="/', 'href="' + siteUrl + '/') };
  }
  if (p === '/static/' || p.startsWith('/static/')) return null;

  if (p === '/days/') {
    const days = dataDays(summaries);
    // link the routable /day/<date>/ pages (root-relative, so withBase prefixes them)
    return { type: 'text/html', body: withBase(`<!doctype html><html><head><meta charset="utf-8"><title>days — redtap</title></head><body><ul>${days.map((d) => `<li><a href="/day/${d}/">${d}</a></li>`).join('')}</ul></body></html>`, base) };
  }

  // post pages
  const postMatch = /^\/(?:r\/([^/]+)\/)?comments\/([^/]+)\/$/.exec(p);
  if (postMatch) {
    const summary = cache(state, '_postByPath', postByPath).get(p);
    if (!summary) return null;
    const sightings = byPost.get(summary.post_id) ?? [];
    return { type: 'text/html', body: withBase(renderPostPage(summary, sightings, now), base) };
  }

  // browse pages
  const q = parseBrowseQuery(p, cache(state, '_subByPath', subredditByPath));
  if (!q) return null;
  let query = q;
  if (queryOverrides) {
    const overrides = Object.fromEntries(Object.entries(queryOverrides).filter(([, v]) => v !== undefined && v !== ''));
    query = { ...q, ...overrides };
  }
  return { type: 'text/html', body: withBase(renderBrowsePage(summaries, query, now), base) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Map a directory-style path to a renderBrowsePage query (subMap: path key →
 *  subreddit value as stored in the data), or null. Mirrors the Space's
 *  segment walk: /r/{sub}/ prefix, one sort keyword, one range keyword (until
 *  a date appears), and up to two dates — a single date is a day page. The
 *  /day/<date>/ static-build shape resolves to the same day query. */
function parseBrowseQuery(p, subMap) {
  if (p === '/') return {};
  let seg = p.split('/').filter(Boolean);
  let subreddit;
  if (seg[0] === 'r' && seg[1]) {
    subreddit = subMap.get(seg[1]);
    if (!subreddit) return null;
    seg.splice(0, 2);
  }
  if (seg[0] === 'day') seg = seg.slice(1); // the static build's day-page prefix
  let sort;
  let range;
  const dates = [];
  for (const s of seg) {
    if (!sort && SORTS.includes(s)) sort = s;
    else if (!range && dates.length === 0 && RANGES.includes(s)) range = s;
    else if (dates.length < 2 && DATE_RE.test(s)) dates.push(s);
    else return null; // unrecognized segment
  }
  if (dates.length === 1) dates.push(dates[0]);
  if (dates.length === 0 && !sort && !range && !subreddit) return null;
  return {
    subreddit,
    sort,
    range: dates.length > 0 ? undefined : range,
    from: dates[0],
    to: dates[1],
  };
}
