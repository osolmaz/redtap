// Static site builder: reads the v2 log from the HF bucket (or the live Space
// stopgap for parity checks) and pre-renders every route for GitHub Pages.
// The render/store path lives in site-lib.mjs and is shared with serve.mjs.

import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allRoutes, dataDays, renderRoute, siteState } from './site-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const REPO = { type: 'bucket', name: process.env.RT_BUCKET ?? arg('bucket', 'osolmaz/redtap-data') };
const token = arg('token', undefined) ?? process.env.HF_TOKEN;
const BASE = arg('base', '');
const OUT = join(here, arg('out', 'dist'));

function write(rel, content, type = 'text/html') {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.error('wrote', rel, type, content.length, 'bytes');
}

/** Copy space/static/ into dist/static/ (favicon and friends). */
function copyStatic() {
  const root = join(here, '..', 'space', 'static');
  let walk;
  try {
    walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else write('static/' + p.slice(root.length + 1), readFileSync(p), 'application/octet-stream');
      }
    };
    walk(root);
  } catch (error) {
    console.error('static copy skipped:', String(error?.message ?? error));
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const fromSpace = arg('from-space', undefined);
  const siteUrl = 'https://osolmaz.github.io' + BASE;
  let state;
  if (fromSpace) {
    // stopgap/parity input: the live Space's summaries (post_at already ms)
    const res = await fetch(fromSpace.replace(/\/$/, '') + '/api/posts');
    const payload = await res.json();
    const summaries = payload.posts;
    console.error('summaries from space:', summaries.length);
    const byPost = new Map();
    for (const p of summaries) {
      byPost.set(p.post_id, [{ captured_at: p.last_seen, metrics: { score: p.score_last, comments: p.comments_last } }]);
    }
    state = { summaries, byPost, now: Date.now(), base: BASE, siteUrl };
  } else {
    state = await siteState({ kind: 'hf', repo: REPO.name, token }, { base: BASE, siteUrl });
  }

  for (const rel of allRoutes(state.summaries)) {
    const rendered = renderRoute(rel, state);
    if (rendered) write(rel, rendered.body, rendered.type);
  }
  copyStatic();

  console.error('site built at', OUT, '—', state.summaries.length, 'posts,', dataDays(state.summaries).length, 'day pages');
}

await main();
