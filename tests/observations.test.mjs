import test from 'node:test';
import assert from 'node:assert/strict';

import { canonical, exactCounter, extractPostRecord, extractSelftext, observationId, parseTimestamp, postsFromApiPayload, recordFromApiPost, shouldSampleUnchanged } from '../extension/lib/observations.js';

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

test('parseTimestamp normalizes Reddit formats into ISO strings', () => {
  assert.equal(parseTimestamp('2026-10-02T00:09:04.914000+0000'), '2026-10-02T00:09:04.914Z');
  assert.equal(parseTimestamp('2026-10-02T00:09:04.914Z'), '2026-10-02T00:09:04.914Z');
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('not-a-date'), null);
  assert.equal(parseTimestamp(null), null);
});

test('extractSelftext reads the text-body slot and normalizes whitespace', () => {
  const withBody = { querySelector: (sel) => (sel === '[slot="text-body"]' ? { textContent: '  line one\n\nline two  ' } : null) };
  assert.equal(extractSelftext(withBody), 'line one line two');
  assert.equal(extractSelftext({ querySelector: () => null }), null);
  assert.equal(extractSelftext({ querySelector: () => ({ textContent: '   ' }) }), null);
  assert.equal(extractSelftext(null), null);
});

test('extractPostRecord includes selftext only when the body renders', async () => {
  const attr = (name) => ({ id: 't3_x1', permalink: '/r/x/comments/x1/y/' })[name] ?? null;
  const withBody = {
    tagName: 'shreddit-post',
    ownerDocument: { URL: 'https://www.reddit.com/r/x/' },
    getAttribute: attr,
    querySelector: () => ({ textContent: 'full body text' }),
  };
  const withoutBody = { ...withBody, querySelector: () => null };
  const a = extractPostRecord(withBody, { capturedAtMs: 1 });
  const b = extractPostRecord(withoutBody, { capturedAtMs: 1 });
  assert.equal(a.selftext, 'full body text');
  assert.equal('selftext' in b, false);
  assert.notEqual(await observationId(a), await observationId(b));
});

test('recordFromApiPost normalizes a reddit t3 entry', () => {
  const entry = {
    id: '1wcbid7',
    title: 'DeepSeek V4.1 Flash is out',
    author: 'someone',
    author_fullname: 't2_abc',
    subreddit: 'LocalLLaMA',
    subreddit_id: 't5_2rc39',
    subreddit_name_prefixed: 'r/LocalLLaMA',
    permalink: '/r/LocalLLaMA/comments/1wcbid7/deepseek_v41_flash_is_out/',
    created_utc: 1790930000.5,
    score: 1200,
    num_comments: 87,
    upvote_ratio: 0.93,
    is_self: true,
    selftext: 'the release notes body',
  };
  const record = recordFromApiPost(entry, { capturedAtMs: 5, sourceEndpoint: '/api/tap' });
  assert.equal(record.post_id, 't3_1wcbid7');
  assert.equal(record.contributed_by, 'tap');
  assert.equal(record.selftext, 'the release notes body');
  assert.equal(record.metrics.comments, 87);
  assert.equal(record.post_at, new Date(1790930000500).toISOString());
  assert.equal(recordFromApiPost({ id: 'x' }), null);
  assert.equal(recordFromApiPost(null), null);
  const removed = recordFromApiPost({ ...entry, selftext: '[removed]' });
  assert.equal('selftext' in removed, false);
});

test('recordFromApiPost keeps reddit preview thumbnails and drops placeholder ones', () => {
  const entry = { id: 'abc', permalink: '/r/x/comments/abc/', thumbnail: 'https://preview.redd.it/pic.jpg?width=640' };
  assert.equal(recordFromApiPost(entry).thumb_href, 'https://preview.redd.it/pic.jpg?width=640');
  assert.equal(recordFromApiPost({ ...entry, thumbnail: 'self' }).thumb_href, null);
  assert.equal(recordFromApiPost({ ...entry, thumbnail: 'default' }).thumb_href, null);
  assert.equal(recordFromApiPost({ id: 'abc', permalink: '/r/x/comments/abc/' }).thumb_href, null);
});

test('postsFromApiPayload walks nested listings and dedupes', () => {
  const post = (id, extra = {}) => ({ kind: 't3', data: { id, title: 't', permalink: '/r/x/comments/' + id + '/', ...extra } });
  const payload = [{ data: { children: [post('a')] } }, { data: { children: [post('a'), post('b')] } }];
  const records = postsFromApiPayload(payload, { capturedAtMs: 7 });
  assert.equal(records.length, 2);
  assert.equal(records[0].post_id, 't3_a');
  assert.equal(records[1].post_id, 't3_b');
});
