// Shared store + render path for redtap serving.
//
// build-site.ts (static pre-render for Pages) and serve.ts (local server)
// both go through this module, so the two never fork the renderer: the same
// renderRoute() powers every route, and the same readV1Lines() powers both
// storage backends (HF bucket or a local folder). Post grouping reuses the
// Space's summarize() so there is exactly one aggregation implementation.

import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { listFiles, downloadFile } from '@huggingface/hub';
import { summarize, type PostSummary } from '../../space/src/record-store.ts';
import { renderBrowsePage, renderPostPage } from '../../space/src/browse.ts';
import { renderRss } from '../../space/src/rss.ts';
import {
  fromV1Lines,
  parseV1Text,
  type ObservationRecord,
  type V1Line,
} from '../../extension/src/lib/v1log.ts';

export const SORTS = ['hot', 'new', 'top', 'rising'];
export const RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];
export const DEFAULT_BUCKET = 'osolmaz/redtap-data';

export type BucketSource =
  | { kind: 'local'; dir: string }
  | { kind: 'hf'; repo: { type: 'bucket'; name: string } | string; token?: string };

export function withBase(html: string, base: string): string {
  if (base === '') return html;
  // prefix every root-relative link and form target so the same html serves
  // at a subpath
  return html.replaceAll('href="/', 'href="' + base + '/').replaceAll('action="/', 'action="' + base + '/');
}

/** Parse one v1 segment (gzipped or plain JSONL) into line objects. */
export function parseSegment(rel: string, bytes: Buffer): V1Line[] {
  const text = rel.endsWith('.gz') ? gunzipSync(bytes).toString('utf-8') : bytes.toString('utf-8');
  return parseV1Text(text);
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (/\.jsonl(\.gz)?$/.test(entry.name)) out.push(p);
  }
}

/** All v1 segment paths under a local bucket-root mirror (a folder holding
 * v1/log/…, or directly the segment folder). Sorted for deterministic order. */
export function listLocalSegments(dir: string): string[] {
  let base = dir;
  try {
    readdirSync(join(dir, 'v1', 'log'));
    base = join(dir, 'v1', 'log'); // a bucket-root mirror with v1/log inside
  } catch {
    // dir itself is the segment folder
  }
  const out: string[] = [];
  walkJsonl(base, out);
  return out.sort();
}

/** Read every line from a folder mirror of the bucket layout. */
function readLocalLines(dir: string): V1Line[] {
  const paths = listLocalSegments(dir);
  console.error('v1 segments:', paths.length);
  return paths.flatMap((path) => parseSegment(path, readFileSync(path)));
}

function hubRepoOf(source: { repo: { type: 'bucket'; name: string } | string }): {
  type: 'bucket';
  name: string;
} {
  return typeof source.repo === 'string' ? { type: 'bucket', name: source.repo } : source.repo;
}

async function bucketSegmentPaths(
  hubRepo: { type: 'bucket'; name: string },
  token: string | undefined,
): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of listFiles({
    repo: hubRepo,
    accessToken: token,
    recursive: true,
    path: 'v1/log/',
    expand: false,
  })) {
    if (typeof entry === 'object' && 'path' in entry) {
      const p = entry.path;
      if (p.endsWith('.jsonl.gz') || p.endsWith('.jsonl')) paths.push(p);
    }
  }
  return paths.sort();
}

/** One bucket segment download with bounded retries. */
async function downloadSegment(
  hubRepo: { type: 'bucket'; name: string },
  token: string | undefined,
  path: string,
): Promise<V1Line[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const blob = await downloadFile({ repo: hubRepo, accessToken: token, path, xet: false });
      if (blob === null) return [];
      return parseSegment(path, Buffer.from(await blob.arrayBuffer()));
    } catch (error) {
      if (attempt >= 4) {
        console.error(
          'giving up on',
          path,
          String((error as Error | undefined)?.message ?? error).slice(0, 100),
        );
        return [];
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** Read every v1 segment line from a backend. */
export async function readV1Lines(source: BucketSource): Promise<V1Line[]> {
  if (source.kind === 'local') return readLocalLines(source.dir);
  const hubRepo = hubRepoOf(source);
  const paths = await bucketSegmentPaths(hubRepo, source.token);
  console.error('v1 segments:', paths.length);
  const lines: V1Line[] = [];
  for (const path of paths) {
    lines.push(...(await downloadSegment(hubRepo, source.token, path)));
  }
  return lines;
}

/** Group records by post and aggregate through the Space's summarize(). */
export type V1Record = ObservationRecord;

export function buildSummaries(unique: V1Record[]): {
  summaries: PostSummary[];
  byPost: Map<string, V1Record[]>;
} {
  const byPost = new Map<string, V1Record[]>();
  for (const r of unique) {
    const list = byPost.get(r.post_id) ?? [];
    list.push(r);
    byPost.set(r.post_id, list);
  }
  const out: PostSummary[] = [...byPost.entries()].map(([post_id, sightings]) => ({
    post_id,
    ...summarize(sightings),
  }));
  out.sort((a, b) => a.post_id.localeCompare(b.post_id));
  return { summaries: out, byPost };
}

export type SiteState = {
  summaries: PostSummary[];
  byPost: Map<string, V1Record[]>;
  now: number;
  base: string;
  siteUrl: string;
};

type SiteStateWithCache = SiteState & Record<string, unknown>;

/** Build the full render state from a backend source. */
export async function siteState(
  source: BucketSource,
  opts: { now?: number; base?: string; siteUrl?: string } = {},
): Promise<SiteState> {
  const lines = await readV1Lines(source);
  const records = fromV1Lines(lines);
  console.error('records:', records.length);
  const { summaries, byPost } = buildSummaries(records);
  return {
    summaries,
    byPost,
    now: opts.now ?? Date.now(),
    base: opts.base ?? '',
    siteUrl: opts.siteUrl ?? '',
  };
}

/** UTC days that have posts (identical derivation in the builder and the server). */
export function dataDays(summaries: PostSummary[]): string[] {
  const dated = summaries.filter((p): p is PostSummary & { post_at: number } => p.post_at !== null);
  return [...new Set(dated.map((p) => new Date(p.post_at).toISOString().slice(0, 10)))].sort();
}

function subKey(sub: string): string {
  return sub.replace(/^r\//i, '');
}

/** The sort/route combos a scope writes; an empty prefix is the root scope. */
function scopeRoutes(prefix: string): string[] {
  const base = prefix === '' ? '' : `${prefix}/`;
  const out = [`${base}index.html`];
  for (const s of SORTS) out.push(`${base}${s}/index.html`);
  for (const s of SORTS) for (const r of RANGES) out.push(`${base}${s}/${r}/index.html`);
  return out;
}

function dayRoutes(day: string): string[] {
  const out = [`day/${day}/index.html`];
  for (const s of SORTS) out.push(`day/${day}/${s}/index.html`);
  return out;
}

function postRoute(summary: PostSummary): string {
  const subPart = summary.subreddit === null ? '' : `r/${subKey(summary.subreddit)}/`;
  return `${subPart}comments/${summary.post_id.replace(/^t3_/, '')}/index.html`;
}

/** Every route the static builder writes, as output-relative paths. */
export function allRoutes(summaries: PostSummary[]): string[] {
  const subs = [...new Set(summaries.map((p) => p.subreddit).filter((sub) => sub !== null))];
  const routes: string[] = scopeRoutes('');
  for (const sub of subs) routes.push(...scopeRoutes(`r/${subKey(sub)}`));
  for (const day of dataDays(summaries)) routes.push(...dayRoutes(day));
  routes.push('days/index.html');
  for (const summary of summaries) routes.push(postRoute(summary));
  routes.push('rss.xml', 'status.json', 'index.json');
  return routes;
}

function cached<T>(state: SiteStateWithCache, key: string, build: (s: SiteState) => T): T {
  if (state[key] === undefined) state[key] = build(state);
  return state[key] as T;
}

function subredditByPath(state: SiteState): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of state.summaries) {
    if (p.subreddit !== null) map.set(subKey(p.subreddit), p.subreddit);
  }
  return map;
}

function postByPath(state: SiteState): Map<string, PostSummary> {
  const map = new Map<string, PostSummary>();
  for (const p of state.summaries) {
    const subPart = p.subreddit === null ? '' : `r/${subKey(p.subreddit)}/`;
    const id = p.post_id.replace(/^t3_/, '');
    map.set(`/${subPart}comments/${id}/`, p);
    map.set(`/comments/${id}/`, p); // short form also resolves
  }
  return map;
}

/** The machine-readable routes (json + rss). */
function renderMachineRoute(p: string, state: SiteState): { type: string; body: string } | null {
  const { summaries, now, siteUrl } = state;
  if (p === '/status.json') {
    return {
      type: 'application/json',
      body: JSON.stringify(
        {
          newestSightingMs: Math.max(...summaries.map((x) => x.last_seen), 0),
          posts: summaries.length,
          builtAt: now,
        },
        null,
        2,
      ),
    };
  }
  if (p === '/index.json') {
    return { type: 'application/json', body: JSON.stringify({ posts: summaries }, null, 1) };
  }
  if (p === '/rss.xml') {
    // rss.xml is the path the rendered pages link (autodiscovery + header)
    return {
      type: 'application/rss+xml',
      body: renderRss(summaries, siteUrl).replace('href="/', `href="${siteUrl}/`),
    };
  }
  return null;
}

/** The days index links the routable /day/<date>/ pages. */
function renderDaysIndex(state: SiteState): { type: string; body: string } {
  const days = dataDays(state.summaries);
  return {
    type: 'text/html',
    body: withBase(
      `<!doctype html><html><head><meta charset="utf-8"><title>days — redtap</title></head><body><ul>${days
        .map((d) => `<li><a href="/day/${d}/">${d}</a></li>`)
        .join('')}</ul></body></html>`,
      state.base,
    ),
  };
}

function renderPostRoute(p: string, state: SiteState): { type: string; body: string } | null {
  const summary = cached(state as SiteStateWithCache, '_postByPath', postByPath).get(p);
  if (summary === undefined) return null;
  const sightings = state.byPost.get(summary.post_id) ?? [];
  return { type: 'text/html', body: withBase(renderPostPage(summary, sightings, state.now), state.base) };
}

function renderBrowseRoute(
  p: string,
  state: SiteState,
  queryOverrides?: Record<string, string | undefined>,
): { type: string; body: string } | null {
  const q = parseBrowseQuery(p, cached(state as SiteStateWithCache, '_subByPath', subredditByPath));
  if (q === null) return null;
  let query = q;
  if (queryOverrides !== undefined) {
    const overrides = Object.fromEntries(
      Object.entries(queryOverrides).filter(([, v]) => v !== undefined && v !== ''),
    );
    query = { ...q, ...overrides };
  }
  return {
    type: 'text/html',
    body: withBase(renderBrowsePage(state.summaries, query, state.now), state.base),
  };
}

/** Normalize a URL-style or output-relative path into a routed path. */
function routePath(pathname: string): string {
  let p = pathname.replace(/^\/+/, '');
  if (p === 'index.html' || p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
  p = '/' + p;
  if (p.length > 1 && !p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p)) p += '/';
  return p;
}

/** Resolve one route to rendered content. `pathname` accepts either a URL-style
 * path ('/hot/day/', '/r/LocalLLaMA/comments/t3_x/') or an output-relative path
 * ('hot/index.html', 'rss.xml'). Returns {body, type} or null when unknown. */
export function renderRoute(
  pathname: string,
  state: SiteState,
  queryOverrides?: Record<string, string | undefined>,
): { type: string; body: string } | null {
  const p = routePath(pathname);
  const machine = renderMachineRoute(p, state);
  if (machine !== null) return machine;
  if (p === '/static/' || p.startsWith('/static/')) return null;
  if (p === '/days/') return renderDaysIndex(state);
  if (/^\/(?:r\/[^/]+\/)?comments\/[^/]+\/$/.test(p)) return renderPostRoute(p, state);
  return renderBrowseRoute(p, state, queryOverrides);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type BrowseQuery = {
  subreddit?: string;
  sort?: string;
  range?: string;
  from?: string;
  to?: string;
};

/** Consume an /r/{sub}/ prefix from the path segments; null when the sub is unknown. */
function takeSubreddit(seg: string[], subMap: Map<string, string>): string | undefined | null {
  if (seg[0] !== 'r' || seg[1] === undefined) return undefined;
  const sub = subMap.get(seg[1]);
  if (sub === undefined) return null;
  seg.splice(0, 2);
  return sub;
}

/** Sort, range, and date keywords in the remaining segments; null on junk. */
// eslint-disable-next-line complexity -- small path-segment state machine; each branch is one keyword class
function takeScopeKeywords(seg: string[]): { sort?: string; range?: string; dates: string[] } | null {
  let sort: string | undefined;
  let range: string | undefined;
  const dates: string[] = [];
  for (const s of seg) {
    if (sort === undefined && SORTS.includes(s)) sort = s;
    else if (range === undefined && dates.length === 0 && RANGES.includes(s)) range = s;
    else if (dates.length < 2 && DATE_RE.test(s)) dates.push(s);
    else return null; // unrecognized segment
  }
  return { sort, range, dates };
}

/** Map a directory-style path to a renderBrowsePage query (subMap: path key →
 * subreddit value as stored in the data), or null. Mirrors the Space's
 * segment walk: /r/{sub}/ prefix, one sort keyword, one range keyword (until
 * a date appears), and up to two dates — a single date is a day page. The
 * /day/<date>/ static-build shape resolves to the same day query. */
// eslint-disable-next-line complexity -- small path-segment state machine
function parseBrowseQuery(p: string, subMap: Map<string, string>): BrowseQuery | null {
  if (p === '/') return {};
  const seg = p.split('/').filter(Boolean);
  const subreddit = takeSubreddit(seg, subMap);
  if (subreddit === null) return null;
  if (seg[0] === 'day') seg.shift(); // the static build's day-page prefix
  const scope = takeScopeKeywords(seg);
  if (scope === null) return null;
  const dates = scope.dates;
  const [firstDate, secondDate] = dates;
  const from = firstDate ?? '';
  const to = secondDate ?? from;
  if (from === '' && scope.sort === undefined && scope.range === undefined && subreddit === undefined) {
    return null;
  }
  if (
    dates.length === 0 &&
    scope.sort === undefined &&
    scope.range === undefined &&
    subreddit === undefined
  ) {
    return null;
  }
  return {
    subreddit,
    sort: scope.sort,
    range: dates.length > 0 ? undefined : scope.range,
    from: from === '' ? undefined : from,
    to: to === from ? undefined : to,
  };
}
