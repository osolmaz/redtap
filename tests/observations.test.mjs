import test from 'node:test';
import assert from 'node:assert/strict';

import { canonical, exactCounter, extractPostRecord, observationId, shouldSampleUnchanged } from '../extension/lib/observations.js';

test('exactCounter accepts only safe digit strings', () => {
  assert.equal(exactCounter('85'), 85);
  assert.equal(exactCounter('0'), 0);
  assert.equal(exactCounter('-3'), null);
  assert.equal(exactCounter('abc'), null);
  assert.equal(exactCounter(null), null);
});

test('canonical is stable across key order', async () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('observation id ignores transport fields', async () => {
  const base = { post_id: 't3_x', title: 't', captured_at: 1, contributed_by: 'local', source_endpoint: '/r/x/' };
  const moved = { ...base, captured_at: 999, source_endpoint: '/r/other/' };
  assert.equal(await observationId(base), await observationId(moved));
  const edited = { ...base, title: 'changed' };
  assert.notEqual(await observationId(base), await observationId(edited));
});

test('sampling gate lets the first sighting through and throttles repeats', () => {
  assert.equal(shouldSampleUnchanged(undefined, 1000), true);
  assert.equal(shouldSampleUnchanged(1000, 1000 + 60_000), false);
  assert.equal(shouldSampleUnchanged(1000, 1000 + 5 * 60_000), true);
});

test('extractPostRecord reads shreddit attributes and skips foreign elements', () => {
  const fake = {
    tagName: 'shreddit-post',
    ownerDocument: { URL: 'https://www.reddit.com/r/LocalLLaMA/' },
    getAttribute: (name) => ({
      id: 't3_1wvffcr',
      'post-title': 'Pi 1.0 released',
      permalink: '/r/LocalLLaMA/comments/1wvffcr/x/',
      score: '85',
      'comment-count': '36',
      'upvote-ratio': '0.956989247311828',
      'subreddit-prefixed-name': 'r/LocalLLaMA',
      author: 'psychohistorian8',
      'created-timestamp': '2026-10-02T00:09:04.914000+0000',
      'post-type': 'link',
    })[name] ?? null,
  };
  const record = extractPostRecord(fake, { capturedAtMs: 42, sourceEndpoint: '/r/LocalLLaMA/' });
  assert.equal(record.post_id, 't3_1wvffcr');
  assert.equal(record.metrics.score, 85);
  assert.equal(record.metrics.upvote_ratio > 0.95, true);
  assert.equal(record.source_endpoint, '/r/LocalLLaMA/');
  assert.equal(extractPostRecord({ tagName: 'div' }), null);
  assert.equal(extractPostRecord({ tagName: 'shreddit-post', getAttribute: () => null }), null);
});
