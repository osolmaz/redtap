import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withBase, parseSegment, listLocalSegments, readV1Lines, siteState, renderRoute, allRoutes, dataDays } from '../builder/site-lib.mjs';
import { makeBucketMirror, POST_AT_MS, POST_DAY } from './helpers/v1-fixture.mjs';

test('withBase prefixes links and form targets, and is a no-op without a base', () => {
  const html = '<form action="/"><a href="/hot/">x</a>';
  assert.equal(withBase(html, '/redtap'), '<form action="/redtap/"><a href="/redtap/hot/">x</a>');
  assert.equal(withBase(html, ''), html);
});

test('parseSegment reads gzip and plain segments and skips malformed lines', async () => {
  const { gzipSync } = await import('node:zlib');
  const good = JSON.stringify({ k: 'sight', oid: 'a' });
  const gz = parseSegment('seg.jsonl.gz', gzipSync(good + '\nnot json\n'));
  assert.deepEqual(gz, [{ k: 'sight', oid: 'a' }]);
  const plain = parseSegment('seg.jsonl', Buffer.from(good + '\n'));
  assert.deepEqual(plain, [{ k: 'sight', oid: 'a' }]);
});

test('listLocalSegments finds segments in a mirror root and in a direct log folder', async () => {
  const root = await makeBucketMirror();
  const segment = join(root, 'v1', 'log', ...POST_DAY.split('-'), POST_AT_MS + '-fixture.jsonl');
  assert.deepEqual(listLocalSegments(root), [segment]);
  const logDir = join(root, 'v1', 'log');
  assert.deepEqual(listLocalSegments(logDir), [segment]);
});

test('the local backend reads the same lines that were written', async () => {
  const root = await makeBucketMirror();
  const lines = await readV1Lines({ kind: 'local', dir: root });
  const kinds = lines.map((l) => l.k);
  assert.equal(kinds.filter((k) => k === 'body').length, 1); // only the post with a selftext
  assert.equal(kinds.filter((k) => k === 'sight').length, 3);
});

test('siteState summarizes the local backend into the record-store shape', async () => {
  const root = await makeBucketMirror();
  const at = POST_AT_MS + 90_000;
  const { summaries, byPost, now } = await siteState({ kind: 'local', dir: root }, { now: at });
  assert.equal(summaries.length, 2);
  assert.equal(byPost.size, 2);
  assert.equal(now, at);
  const first = summaries.find((p) => p.post_id === 't3_fix000');
  assert.equal(first.title, 'Fixture post');
  assert.equal(first.score_first, 10);
  assert.equal(first.score_last, 12);
  assert.equal(first.score_delta, 2);
  assert.equal(first.observations, 2);
  assert.ok(first.selftext.includes('hello fixture body'));
});

test('renderRoute resolves every route family and rejects unknown paths', async () => {
  const root = await makeBucketMirror();
  const state = await siteState({ kind: 'local', dir: root }, { base: '', siteUrl: 'http://127.0.0.1:8088' });
  for (const rel of allRoutes(state.summaries)) {
    assert.ok(renderRoute(rel, state), 'builder route must render: ' + rel);
  }
  assert.equal(renderRoute('/rss.xml', state).type, 'application/rss+xml');
  assert.equal(JSON.parse(renderRoute('/status.json', state).body).posts, 2);
  assert.equal(JSON.parse(renderRoute('/index.json', state).body).posts.length, 2);
  assert.ok(renderRoute('/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/hot/day/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/day/' + POST_DAY + '/', state).body.includes('Fixture post'));
  // date shapes the pages themselves link: day nav (/date/ and /from/to/)
  assert.ok(renderRoute('/' + POST_DAY + '/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/2020-01-01/2030-01-01/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/r/LocalLLaMA/' + POST_DAY + '/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/hot/', state, { from: POST_DAY, to: POST_DAY }).body.includes('Fixture post'));
  assert.ok(renderRoute('/r/LocalLLaMA/top/month/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/r/LocalLLaMA/comments/fix000/', state).body.includes('Fixture post'));
  assert.ok(renderRoute('/comments/fix001/', state).body.includes('Second fixture post'));
  // the days index links the routable /day/<date>/ pages
  assert.ok(renderRoute('/days/', state).body.includes('href="/day/' + POST_DAY + '/"'));
  assert.equal(renderRoute('/nope/', state), null);
  assert.equal(renderRoute('/r/Missing/comments/fix000/', state), null);
  assert.equal(renderRoute('/static/icon48.png', state), null);
});

test('dataDays derives the UTC day list from post_at', async () => {
  const root = await makeBucketMirror();
  const { summaries } = await siteState({ kind: 'local', dir: root });
  assert.deepEqual(dataDays(summaries), [POST_DAY]);
});
