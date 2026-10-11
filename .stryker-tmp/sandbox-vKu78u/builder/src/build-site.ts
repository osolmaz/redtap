#!/usr/bin/env node
// @ts-nocheck
// Static site builder: reads the v1 log from the HF bucket (or the live Space
// stopgap for parity checks) and pre-renders every route for GitHub Pages.
// The render/store path lives in site-lib.ts and is shared with serve.ts.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { allRoutes, dataDays, renderRoute, siteState, DEFAULT_BUCKET } from './site-lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    bucket: { type: 'string' },
    token: { type: 'string' },
    base: { type: 'string', default: '' },
    out: { type: 'string', default: 'dist' },
    'from-space': { type: 'string' },
  },
  strict: false,
});

const strArg = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const REPO = {
  type: 'bucket' as const,
  name: process.env.RT_BUCKET ?? strArg(values.bucket) ?? DEFAULT_BUCKET,
};
const token = strArg(values.token) ?? process.env.HF_TOKEN;
const BASE = strArg(values.base) ?? '';
const OUT = join(here, strArg(values.out) ?? 'dist');

function write(rel: string, content: string, type = 'text/html'): void {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.error('wrote', rel, type, content.length, 'bytes');
}

/** Copy space/static/ into dist/static/ (favicon and friends). */
function copyStatic(): void {
  const root = join(here, '..', '..', 'space', 'static');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else write('static/' + p.slice(root.length + 1), readFileSync(p, 'utf-8'), 'application/octet-stream');
    }
  };
  try {
    walk(root);
  } catch (error) {
    console.error('static copy skipped:', String((error as Error | undefined)?.message ?? error));
  }
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  const fromSpace = strArg(values['from-space']);
  const siteUrl = 'https://osolmaz.github.io' + BASE;
  let state;
  if (fromSpace) {
    // stopgap/parity input: the live Space's summaries (post_at already ms)
    const res = await fetch(fromSpace.replace(/\/$/, '') + '/api/posts');
    const payload = (await res.json()) as { posts: Record<string, unknown>[] };
    const summaries = payload.posts;
    console.error('summaries from space:', summaries.length);
    const byPost = new Map<string, Record<string, unknown>[]>();
    for (const p of summaries) {
      byPost.set(String(p.post_id), [
        { captured_at: p.last_seen, metrics: { score: p.score_last, comments: p.comments_last } },
      ]);
    }
    state = { summaries, byPost, now: Date.now(), base: BASE, siteUrl } as never;
  } else {
    state = await siteState({ kind: 'hf', repo: REPO.name, token }, { base: BASE, siteUrl });
  }

  for (const rel of allRoutes(state.summaries)) {
    const rendered = renderRoute(rel, state);
    if (rendered) write(rel, rendered.body, rendered.type);
  }
  copyStatic();

  console.error(
    'site built at',
    OUT,
    '—',
    state.summaries.length,
    'posts,',
    dataDays(state.summaries).length,
    'day pages',
  );
}

await main();
