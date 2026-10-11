import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const hubState = vi.hoisted((): { paths: string[]; blobs: Record<string, Uint8Array<ArrayBuffer>> } => ({
  paths: [],
  blobs: {},
}));
vi.mock('@huggingface/hub', () => ({
  listFiles: async function* gen() {
    for (const p of hubState.paths) yield { path: p };
  },
  downloadFile: async ({ path }: { path: string }) =>
    hubState.blobs[path] === undefined ? null : new Blob([hubState.blobs[path]]),
}));

import {
  withBase,
  parseSegment,
  listLocalSegments,
  readV1Lines,
  siteState,
  renderRoute,
  allRoutes,
  dataDays,
} from '../builder/src/site-lib.ts';
import { makeBucketMirror, POST_AT_MS, POST_DAY } from './helpers/v1-fixture.ts';

describe('site-lib', () => {
  it('withBase prefixes links and form targets, and is a no-op without a base', () => {
    const html = '<form action="/"><a href="/hot/">x</a>';
    expect(withBase(html, '/redtap')).toBe('<form action="/redtap/"><a href="/redtap/hot/">x</a>');
    expect(withBase(html, '')).toBe(html);
  });

  it('parseSegment reads gzip and plain segments and skips malformed lines', () => {
    const good = JSON.stringify({
      k: 'sight',
      oid: 'a',
      post_id: 't3_x',
      t: 1,
      src: '/api/tap',
      by: 'tap',
      h: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    const gz = parseSegment('seg.jsonl.gz', gzipSync(good + '\nnot json\n'));
    expect(gz.length).toBe(1);
    expect(gz[0]!.k).toBe('sight');
    const plain = parseSegment('seg.jsonl', Buffer.from(good + '\n'));
    expect(plain.length).toBe(1);
  });

  it('listLocalSegments finds segments in a mirror root and in a direct log folder', async () => {
    const root = await makeBucketMirror();
    const segment = join(root, 'v1', 'log', ...POST_DAY.split('-'), `${POST_AT_MS}-fixture.jsonl`);
    expect(listLocalSegments(root)).toEqual([segment]);
    expect(listLocalSegments(join(root, 'v1', 'log'))).toEqual([segment]);
  });

  it('the local backend reads the same lines that were written', async () => {
    const root = await makeBucketMirror();
    const lines = await readV1Lines({ kind: 'local', dir: root });
    const kinds = lines.map((l) => l.k);
    expect(kinds.filter((k) => k === 'body').length).toBe(1); // only the post with a selftext
    expect(kinds.filter((k) => k === 'sight').length).toBe(3);
  });

  it('siteState summarizes the local backend into the record-store shape', async () => {
    const root = await makeBucketMirror();
    const at = POST_AT_MS + 90_000;
    const { summaries, byPost, now } = await siteState({ kind: 'local', dir: root }, { now: at });
    expect(summaries.length).toBe(2);
    expect(byPost.size).toBe(2);
    expect(now).toBe(at);
    const first = summaries.find((p) => p.post_id === 't3_fix000')!;
    expect(first.title).toBe('Fixture post');
    expect(first.score_first).toBe(10);
    expect(first.score_last).toBe(12);
    expect(first.score_delta).toBe(2);
    expect(first.observations).toBe(2);
    expect(first.selftext!.includes('hello fixture body')).toBe(true);
  });

  it('renderRoute resolves every route family and rejects unknown paths', async () => {
    const root = await makeBucketMirror();
    const state = await siteState(
      { kind: 'local', dir: root },
      { base: '', siteUrl: 'http://127.0.0.1:8088' },
    );
    expect(renderRoute('/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/hot/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/' + POST_DAY + '/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/2020-01-01/2030-01-01/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/r/LocalLLaMA/' + POST_DAY + '/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/hot/', state, { from: POST_DAY, to: POST_DAY })!.body).toContain('Fixture post');
    expect(renderRoute('/r/LocalLLaMA/top/month/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/r/LocalLLaMA/comments/fix000/', state)!.body).toContain('Fixture post');
    expect(renderRoute('/comments/fix001/', state)!.body).toContain('Second fixture post');
    // the days index links the routable /day/<date>/ pages
    expect(renderRoute('/days/', state)!.body).toContain('href="/day/' + POST_DAY + '/"');
    expect(renderRoute('/nope/', state)).toBeNull();
    expect(renderRoute('/r/Missing/comments/fix000/', state)).toBeNull();
    expect(renderRoute('/static/icon48.png', state)).toBeNull();
  });

  it('renderRoute serves the machine routes: status.json, index.json, rss.xml', async () => {
    const root = await makeBucketMirror();
    const state = await siteState(
      { kind: 'local', dir: root },
      { base: '', siteUrl: 'http://127.0.0.1:8088' },
    );
    const status = JSON.parse(renderRoute('/status.json', state)!.body) as { posts: number };
    expect(status.posts).toBe(2);
    const index = JSON.parse(renderRoute('/index.json', state)!.body) as { posts: unknown[] };
    expect(index.posts.length).toBe(2);
    const rss = renderRoute('/rss.xml', state)!;
    expect(rss.type).toBe('application/rss+xml');
    expect(rss.body).toContain('<?xml');
    expect(rss.body).toContain('http://127.0.0.1:8088/');
    expect(renderRoute('/static/icon48.png', state)).toBeNull();
  });

  it('the hf backend lists, downloads, and parses the bucket segments', async () => {
    const { gzipSync } = await import('node:zlib');
    const root = await makeBucketMirror();
    const seg = join(root, 'v1', 'log', ...POST_DAY.split('-'), `${POST_AT_MS}-fixture.jsonl`);
    const plain = readFileSync(seg, 'utf-8');
    const gzSeg = `${POST_AT_MS}-gz.jsonl.gz`;
    hubState.paths = [`v1/log/${gzSeg}`, 'v1/log/missing.jsonl.gz'];
    hubState.blobs = { [`v1/log/${gzSeg}`]: new Uint8Array(gzipSync(plain)) };
    const lines = await readV1Lines({ kind: 'hf', repo: 'osolmaz/redtap-data', token: 'tok' });
    console.log('PATHS-IN', hubState.paths.join(' | '));
    expect(lines.filter((l) => l.k === 'sight').length).toBe(3);
    hubState.paths = [];
    hubState.blobs = {};
  });

  it('renderRoute serves machine routes with a base and rss absolute links', async () => {
    const root = await makeBucketMirror();
    const state = await siteState(
      { kind: 'local', dir: root },
      { base: '/redtap', siteUrl: 'https://osolmaz.github.io/redtap' },
    );
    const rss = renderRoute('/rss.xml', state)!;
    expect(rss.type).toBe('application/rss+xml');
    expect(rss.body).toContain('<link>https://osolmaz.github.io/redtap/</link>');
    const status = JSON.parse(renderRoute('/status.json', state)!.body) as { posts: number };
    expect(status.posts).toBe(2);
    // output-relative paths resolve like their URL forms
    expect(renderRoute('hot/index.html', state)).not.toBeNull();
    expect(renderRoute('rss.xml', state)!.type).toBe('application/rss+xml');
    expect(renderRoute('/days/', state)!.body).toContain('href="/redtap/day/');
  });

  it('dataDays derives the UTC day list from post_at', async () => {
    const root = await makeBucketMirror();
    const { summaries } = await siteState({ kind: 'local', dir: root });
    expect(dataDays(summaries)).toEqual([POST_DAY]);
  });

  it('allRoutes enumerates every route the builder writes', async () => {
    const root = await makeBucketMirror();
    const { summaries } = await siteState({ kind: 'local', dir: root });
    const routes = allRoutes(summaries);
    expect(routes).toContain('index.html');
    expect(routes).toContain('hot/index.html');
    expect(routes).toContain('r/LocalLLaMA/top/month/index.html');
    expect(routes).toContain(`day/${POST_DAY}/index.html`);
    expect(routes).toContain('days/index.html');
    expect(routes).toContain('r/LocalLLaMA/comments/fix000/index.html');
    expect(routes).toContain('rss.xml');
    expect(routes).toContain('status.json');
    expect(routes).toContain('index.json');
  });
});
