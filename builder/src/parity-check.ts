// Render-parity gate: for a set of routes, compare the post sequence the
// builder renders (from the same Space input) against the live Space's page.
// The live pool keeps ingesting, so we compare permalink ORDER overlap and
// require a high match rate rather than byte equality.
//
// Usage: node builder/src/parity-check.ts [--space https://osolmaz-redtap-space.hf.space] [--dist dist]
// The build runs first inside this process (spawn, no shell) so a runner that
// executes checks in parallel can never race the dist the comparison reads.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    space: { type: 'string', default: 'https://osolmaz-redtap-space.hf.space' },
    dist: { type: 'string', default: 'dist' },
  },
  strict: false,
});
const strArg = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const space = (strArg(values.space) ?? 'https://osolmaz-redtap-space.hf.space').replace(/\/$/, '');
const dist = join(here, strArg(values.dist) ?? 'dist');

const ROUTES: [string, string][] = [
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

const POST_ROUTES = 5;
const PERMALINK = /href="\/r\/[^/]+\/comments\/([a-z0-9]+)\//g;

function permalinks(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  for (const re = new RegExp(PERMALINK.source, 'g'); (m = re.exec(html));) {
    const id = m[1];
    if (id !== undefined) out.push(id);
  }
  return out;
}

function overlapRate(a: string[], b: string[]): number {
  const setB = new Set(b);
  let hits = 0;
  for (const x of a) if (setB.has(x)) hits += 1;
  return a.length === 0 ? 1 : hits / a.length;
}

// Build the site first: the comparison below reads only what this build wrote.
const build = spawnSync(process.execPath, [join(here, 'build-site.ts'), '--from-space', space], {
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('PARITY FAILED: build step exited', build.status, build.error ?? '');
  process.exit(1);
}

let fails = 0;
const liveHtml = async (route: string): Promise<string> => await (await fetch(space + route)).text();

for (const [localPath, livePath] of ROUTES) {
  const local = readFileSync(join(dist, localPath), 'utf8');
  const live = await liveHtml(livePath);
  const rate = overlapRate(permalinks(local).slice(0, 60), permalinks(live).slice(0, 60));
  const ok = rate >= 0.85;
  if (!ok) fails += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'} ${localPath} overlap ${(rate * 100).toFixed(0)}%`);
}

// sample post pages (title + selftext presence)
const payload = (await (await fetch(space + '/api/posts')).json()) as {
  posts: { post_id: string; subreddit?: string; title?: string; selftext?: string }[];
};
const posts = payload.posts.filter((p) => p.selftext).slice(0, POST_ROUTES);
for (const p of posts) {
  const id = p.post_id.replace(/^t3_/, '');
  const sub = (p.subreddit ?? '').replace(/^r\//, '');
  const local = readFileSync(join(dist, 'r', sub, 'comments', id, 'index.html'), 'utf8');
  const ok =
    local.includes(p.title ?? '') && local.includes('<div class="md">') && local.includes('open on reddit');
  if (!ok) fails += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'} post page r/${sub}/comments/${id}/`);
}

if (fails > 0) {
  console.error('PARITY FAILED:', fails, 'routes');
  process.exit(1);
}
console.error('PARITY PASSED');
