// Pre-render the redtap site from the v2 bucket log into ./dist for GitHub
// Pages. Reuses the Space's render functions as pure functions; adds a base
// prefix rewrite so the same HTML serves at a Pages subpath.
//
// Usage: node builder/build-site.mjs [--token <hfToken>] [--bucket osolmaz/redtap-data] [--base /redtap] [--out dist]

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, downloadFile } from '@huggingface/hub';

import { fromV2Lines } from '../extension/lib/v2log.js';
import { renderBrowsePage, renderPostPage } from '../space/src/browse.ts';
import { renderRss } from '../space/src/rss.ts';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const REPO = { type: 'bucket', name: process.env.RT_BUCKET ?? arg('bucket', 'osolmaz/redtap-data') };
const token = arg('token', undefined);
const BASE = arg('base', '');
const OUT = join(here, arg('out', 'dist'));

const digest = async (bytes) => createHash('sha256').update(bytes).digest('hex');

function withBase(html) {
  if (!BASE) return html;
  return html.replaceAll('href="/', 'href="' + BASE + '/').replaceAll('action="' + BASE + '/', 'action="/');
}

async function readV2Lines() {
  const paths = [];
  for await (const entry of listFiles({ repo: REPO, accessToken: token, recursive: true, path: 'v2/log/', expand: false })) {
    if (typeof entry === 'object' && 'path' in entry) {
      const p = String(entry.path);
      if (p.endsWith('.jsonl.gz') || p.endsWith('.jsonl')) paths.push(p);
    }
  }
  paths.sort();
  console.error('v2 segments:', paths.length);
  const lines = [];
  for (const path of paths) {
    for (let attempt = 1; ; attempt++) {
      try {
        const blob = await downloadFile({ repo: REPO, accessToken: token, path, xet: false });
        if (!blob) break;
        const bytes = Buffer.from(await blob.arrayBuffer());
        const text = path.endsWith('.gz') ? gunzipSync(bytes).toString('utf-8') : bytes.toString('utf-8');
        for (const raw of text.split('\n')) {
          if (!raw.trim()) continue;
          try { lines.push(JSON.parse(raw)); } catch {}
        }
        break;
      } catch (error) {
        if (attempt >= 4) { console.error('giving up on', path, String(error?.message ?? error).slice(0, 100)); break; }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return lines;
}

const SORTS = ['hot', 'new', 'top', 'rising'];
const RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];

function write(rel, content, type = 'text/html') {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.error('wrote', rel, type, content.length, 'bytes');
}

/** Group deduped records into PostSummaries (the Space's record-store shape). */
function buildSummaries(unique) {
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
    const postAt = sightings.map((s) => s.post_at).find((t) => typeof t === 'string' && t.length > 0) ?? null;
    const postAtMs = postAt ? Date.parse(postAt) : null;
    return {
      post_id,
      subreddit: last.subreddit ?? first.subreddit ?? null,
      title: last.title ?? first.title ?? null,
      author: last.author ?? first.author ?? null,
      permalink: last.permalink ?? first.permalink ?? '',
      content_href: last.content_href ?? first.content_href ?? null,
      thumb_href: last.thumb_href ?? first.thumb_href ?? null,
      post_type: last.post_type ?? first.post_type ?? null,
      post_at: Number.isFinite(postAtMs) && postAtMs > 1117584000000 && postAtMs < Date.now() + 86400000 ? postAtMs : null,
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
  return out;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const fromSpace = arg('from-space', undefined);
  let summaries;
  if (fromSpace) {
    // stopgap/parity input: the live Space's summaries (post_at already ms)
    const res = await fetch(fromSpace.replace(/\/$/, '') + '/api/posts');
    const payload = await res.json();
    summaries = payload.posts;
    console.error('summaries from space:', summaries.length);
  } else {
    const lines = await readV2Lines();
    const records = fromV2Lines(lines);
    console.error('records:', records.length);
    summaries = buildSummaries(records);
  }

  // sightings per post (for the post-page charts); the Space stopgap has one
  let sightingsByPost = new Map();
  if (fromSpace) {
    for (const p of summaries) {
      sightingsByPost.set(p.post_id, [{ captured_at: p.last_seen, metrics: { score: p.score_last, comments: p.comments_last } }]);
    }
  } else {
    sightingsByPost = byPost;
  }
  const now = Date.now();

  const render = (q) => withBase(renderBrowsePage(summaries, q, now));

  // root + sorts + sort x scope
  write('index.html', render({}));
  for (const s of SORTS) write(`${s}/index.html`, render({ sort: s }));
  for (const s of SORTS) for (const r of RANGES) write(`${s}/${r}/index.html`, render({ sort: s, range: r }));

  // subreddit pages (the pool is single-sub, but mirror the space routes)
  const subs = [...new Set(summaries.map((p) => p.subreddit).filter(Boolean))];
  for (const sub of subs) {
    const subPath = 'r/' + sub.replace(/^r\//i, '');
    write(`${subPath}/index.html`, render({ subreddit: sub }));
    for (const s of SORTS) write(`${subPath}/${s}/index.html`, render({ subreddit: sub, sort: s }));
    for (const s of SORTS) for (const r of RANGES) write(`${subPath}/${s}/${r}/index.html`, render({ subreddit: sub, sort: s, range: r }));
  }

  // day pages (HN-style): every UTC day present in the data, per sort
  const days = [...new Set(summaries.filter((p) => p.post_at).map((p) => new Date(p.post_at).toISOString().slice(0, 10)))].sort();
  for (const day of days) {
    for (const s of SORTS) write(`day/${day}/${s}/index.html`, render({ sort: s, from: day, to: day }));
    write(`day/${day}/index.html`, render({ sort: 'hot', from: day, to: day }));
  }
  write('days/index.html', withBase(`<!doctype html><html><head><meta charset="utf-8"><title>days — redtap</title></head><body><ul>${days.map((d) => `<li><a href="./${d}/">${d}</a></li>`).join('')}</ul></body></html>`));

  // standalone post pages
  for (const summary of summaries) {
    const sightings = sightingsByPost.get(summary.post_id) ?? [];
    const subPart = summary.subreddit ? 'r/' + summary.subreddit.replace(/^r\//i, '') + '/' : '';
    write(`${subPart}comments/${summary.post_id.replace(/^t3_/, '')}/index.html`, withBase(renderPostPage(summary, sightings, now)));
  }

  // rss + freshness banner data
  write('feed.xml', withBase(renderRss(summaries, 'https://osolmaz.github.io' + BASE)).replace('href="/', 'href="https://osolmaz.github.io' + BASE + '/'), 'application/rss+xml');
  write('status.json', JSON.stringify({ newestSightingMs: Math.max(...summaries.map((p) => p.last_seen), 0), posts: summaries.length, builtAt: now }, null, 2));
  write('index.json', JSON.stringify({ posts: summaries }, null, 1));

  console.error('site built at', OUT, '—', summaries.length, 'posts,', days.length, 'day pages');
}

await main();
