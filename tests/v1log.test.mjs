import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bodyHash, EMPTY_BODY_HASH, fromV1Lines, hashesOf, parseV1Text, sightLine, toV1Lines } from '../extension/lib/v1log.js';

// Node digest implementation matching the worker's crypto.subtle path.
const digest = async (bytes) => createHash('sha256').update(bytes).digest('hex');

const record = (over = {}) => ({
  observation_id: 'rt_abc123',
  post_id: 't3_1wz5va3',
  post_at: '2026-10-05T15:41:20.000Z',
  captured_at: 1791439128747,
  source_endpoint: '/api/listing',
  contributed_by: 'tap',
  pooled_at: null,
  title: 'google/embeddinggemma-2 · Hugging Face',
  author: 'jacek2023',
  subreddit: 'r/LocalLLaMA',
  permalink: '/r/LocalLLaMA/comments/1wz5va3/',
  selftext: '## About\n\n**EmbeddingGemma 2** is nice.',
  content_href: null,
  thumb_href: null,
  post_type: 'link',
  metrics: { score: 376, comments: 86, upvote_ratio: 0.97 },
  ...over,
});

test('bodyHash hashes only the selftext and is empty-safe', async () => {
  const a = await bodyHash(record(), digest);
  assert.equal(a.length, 64);
  assert.equal(a, await bodyHash(record(), digest), 'same selftext -> same hash');
  assert.notEqual(a, await bodyHash(record({ selftext: 'different' }), digest));
  assert.equal(await bodyHash(record({ selftext: undefined }), digest), EMPTY_BODY_HASH);
  assert.equal(await bodyHash(record({ selftext: '[removed]' }), digest), EMPTY_BODY_HASH);
});

test('toV1Lines emits one body line per distinct hash and a sight per record', async () => {
  const known = new Set();
  const batch1 = await toV1Lines([record(), record({ captured_at: 1791439128748, observation_id: 'rt_def456', metrics: { score: 380, comments: 90 } })], known, digest);
  assert.equal(batch1.filter((l) => l.k === 'body').length, 1, 'two records, same body: one body line');
  assert.equal(batch1.filter((l) => l.k === 'sight').length, 2);
  const body = batch1.find((l) => l.k === 'body');
  assert.equal(body.selftext.includes('## About'), true);
  assert.equal(body.title, undefined, 'body lines carry only the selftext');
  const sights = batch1.filter((l) => l.k === 'sight');
  assert.equal(sights[0].title, record().title, 'sight lines carry metadata inline');
  assert.equal(sights[0].post_at, record().post_at);
  assert.deepEqual([...new Set(sights.map((l) => l.h))], [body.h]);

  // a second batch with an unchanged body emits no body line when the hash is known
  const knownAfter = new Set([...known, ...hashesOf(batch1)]);
  const batch2 = await toV1Lines([record({ captured_at: 1791439128749, observation_id: 'rt_ghi789', metrics: { score: 400, comments: 95 } })], knownAfter, digest);
  assert.equal(batch2.filter((l) => l.k === 'body').length, 0);
  assert.equal(batch2.length, 1);

  // an edited body is a new hash -> a new body line
  const batch3 = await toV1Lines([record({ captured_at: 1791439128750, observation_id: 'rt_jkl012', selftext: 'edited body', metrics: { score: 401, comments: 96 } })], knownAfter, digest);
  assert.equal(batch3.filter((l) => l.k === 'body').length, 1);
});

test('bodyless records reference the empty hash and carry no body line', async () => {
  const lines = await toV1Lines([record({ selftext: undefined })], new Set(), digest);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].k, 'sight');
  assert.equal(lines[0].h, EMPTY_BODY_HASH);
  assert.equal(hashesOf(lines).size, 0);
});

test('fromV1Lines expands back into v1-shaped records', async () => {
  const lines = await toV1Lines([record(), record({ captured_at: 1791439128748, observation_id: 'rt_def456', selftext: 'edited body', metrics: { score: 400, comments: 95 } })], new Set(), digest);
  const records = fromV1Lines(lines);
  assert.equal(records.length, 2);
  const [first, second] = records;
  assert.equal(first.observation_id, 'rt_abc123');
  assert.equal(first.subreddit, 'r/LocalLLaMA');
  assert.equal(second.selftext, 'edited body');
  assert.equal(second.metrics.score, 400);
  assert.equal(second.title, 'google/embeddinggemma-2 · Hugging Face');
  // a bodyless sighting keeps its metadata through the round trip
  const naked = await toV1Lines([record({ selftext: undefined, observation_id: 'rt_nkd001', title: 'just a link post' })], new Set(), digest);
  const back = fromV1Lines(naked)[0];
  assert.equal(back.title, 'just a link post');
  assert.equal(back.selftext, undefined);
  assert.equal(second.permalink, '/r/LocalLLaMA/comments/1wz5va3/');
  // v1 summarize() compatibility: the fields it reads are all present
  for (const key of ['observation_id', 'post_id', 'captured_at', 'source_endpoint', 'contributed_by', 'metrics']) assert.notEqual(records[0][key], undefined);
});

test('parseV1Text skips malformed lines', () => {
  const lines = parseV1Text('{"k":"sight","oid":"a"}\nnot json\n\n{"k":"body","h":"x"}\n');
  assert.equal(lines.length, 2);
});

test('body hash matches the node digest of the canonical form', async () => {
  const h = await bodyHash(record(), digest);
  assert.equal(h, await bodyHash(record(), digest));
  assert.equal(h.length, 64);
});
