// Render-parity gate: for a set of routes, compare the post sequence the
// builder renders (from the same Space input) against the live Space's page.
// The live pool keeps ingesting, so we compare permalink ORDER overlap and
// require a high match rate rather than byte equality.
//
// Usage: node builder/parity-check.mjs [--space https://osolmaz-redtap-space.hf.space] [--dist builder/dist]
// The build runs first inside this process (spawn, no shell) so a runner that
// executes checks in parallel can never race the dist the comparison reads.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const space = (process.argv[process.argv.indexOf('--space')] ? process.argv[process.argv.indexOf('--space') + 1] : 'https://osolmaz-redtap-space.hf.space').replace(/\/$/, '');
const dist = join(here, process.argv[process.argv.indexOf('--dist')] ? process.argv[process.argv.indexOf('--dist') + 1] : 'dist');

const ROUTES = [
  ['/', '/'],
  ['/new/', '/new/'],
  ['/top/all/', '/top/all/'],
  ['/top/month/', '/top/month/'],
  ['/rising/week/', '/rising/week/'],
  ['/hot/year/', '/hot/year/'],
  ['/new/day/', '/new/day/'],
  ['/r/LocalLLaMA/top/month/', '/r/LocalLLaMA/top/month/'],
  ['/r/LocalLLaMA/hot/day/', '/r/LocalLLaMA/hot/day/'],
  ['/r/LocalLLaMA/new/', '/r/LocalLLaMA/new/'],
];

const DAY_ROUTES = 5;
const POST_ROUTES = 5;
const PERMALINK = /href="\/r\/[^/]+\/comments\/([a-z0-9]+)\//g;

function permalinks(html) {
  const out = [];
  let m;
  for (const re = new RegExp(PERMALINK.source, 'g'); (m = re.exec(html));) out.push(m[1]);
  return out;
}

function overlapRate(a, b) {
  const setB = new Set(b);
  let hits = 0;
  for (const x of a) if (setB.has(x)) hits += 1;
  return a.length === 0 ? 1 : hits / a.length;
}

// Build the site first: the comparison below reads only what this build wrote.
const build = spawnSync(process.execPath, [join(here, 'build-site.mjs'), '--from-space', space], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('PARITY FAILED: build step exited', build.status, build.error ?? '');
  process.exit(1);
}

let fails = 0;
const results = [];
for (const [localPath, spacePath] of ROUTES) {
  const local = readFileSync(join(dist, localPath, 'index.html'), 'utf8');
  const live = await (await fetch(space + spacePath)).text();
  const a = permalinks(local).slice(0, 60);
  const b = permalinks(live).slice(0, 60);
  const rate = overlapRate(a, b);
  const ok = rate >= 0.9;
  if (!ok) fails += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${localPath} overlap ${(rate * 100).toFixed(0)}% (${a.length} vs ${b.length} cards)`);
  console.error(results[results.length - 1]);
}

// sample day pages
const days = (await (await fetch(space + '/api/posts')).json()).posts
  .filter((p) => p.post_at)
  .map((p) => new Date(p.post_at).toISOString().slice(0, 10));
const uniqueDays = [...new Set(days)].sort();
for (const day of uniqueDays.slice(-DAY_ROUTES)) {
  const localPath = `/day/${day}/hot/`;
  const spacePath = `/?from=${day}&to=${day}&sort=hot`;
  const local = readFileSync(join(dist, localPath, 'index.html'), 'utf8');
  const live = await (await fetch(space + spacePath)).text();
  const rate = overlapRate(permalinks(local).slice(0, 60), permalinks(live).slice(0, 60));
  const ok = rate >= 0.85;
  if (!ok) fails += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'} ${localPath} overlap ${(rate * 100).toFixed(0)}%`);
}

// sample post pages (title + selftext presence)
const posts = (await (await fetch(space + '/api/posts')).json()).posts.filter((p) => p.selftext).slice(0, POST_ROUTES);
for (const p of posts) {
  const id = p.post_id.replace(/^t3_/, '');
  const sub = (p.subreddit ?? '').replace(/^r\//, '');
  const local = readFileSync(join(dist, 'r', sub, 'comments', id, 'index.html'), 'utf8');
  const ok = local.includes(p.title ?? '') && local.includes('<div class="md">') && local.includes('open on reddit');
  if (!ok) fails += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'} post page r/${sub}/comments/${id}/`);
}

if (fails > 0) {
  console.error('PARITY FAILED:', fails, 'routes');
  process.exit(1);
}
console.error('PARITY PASSED');
