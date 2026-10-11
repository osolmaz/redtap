// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  canonical,
  exactCounter,
  extractPostRecord,
  observationId,
  parseTimestamp,
  postsFromApiPayload,
  recordFromApiPost,
  shouldSampleUnchanged,
} from '../extension/src/lib/observations.ts';

describe('observations', () => {
  it('canonical is stable across key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it('observation id ignores transport fields', async () => {
    const base = {
      post_id: 't3_x',
      title: 't',
      captured_at: 1,
      contributed_by: 'local',
      source_endpoint: '/r/x/',
    };
    const moved = { ...base, captured_at: 999, source_endpoint: '/r/other/' };
    expect(await observationId(base)).toBe(await observationId(moved));
    const edited = { ...base, title: 'changed' };
    expect(await observationId(base)).not.toBe(await observationId(edited));
  });

  it('sampling gate lets the first sighting through and throttles repeats', () => {
    expect(shouldSampleUnchanged(undefined, 1000)).toBe(true);
    expect(shouldSampleUnchanged(1000, 1000 + 60_000)).toBe(false);
    expect(shouldSampleUnchanged(1000, 1000 + 5 * 60_000)).toBe(true);
  });

  it('extractPostRecord reads shreddit attributes and skips foreign elements', () => {
    const fake = {
      tagName: 'shreddit-post',
      ownerDocument: { URL: 'https://www.reddit.com/r/LocalLLaMA/' },
      getAttribute: (name: string): string | null =>
        ({
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
    const record = extractPostRecord(fake, {
      capturedAtMs: 42,
      sourceEndpoint: '/r/LocalLLaMA/',
    });
    expect(record!.post_id).toBe('t3_1wvffcr');
    expect(record!.metrics.score).toBe(85);
    expect(record!.metrics.upvote_ratio! > 0.95).toBe(true);
    expect(record!.source_endpoint).toBe('/r/LocalLLaMA/');
    expect(extractPostRecord({ tagName: 'div' })).toBeNull();
    expect(extractPostRecord({ tagName: 'shreddit-post', getAttribute: () => null })).toBeNull();
  });

  it('parseTimestamp normalizes Reddit formats into ISO strings', () => {
    expect(parseTimestamp('2026-10-02T00:09:04.914000+0000')).toBe('2026-10-02T00:09:04.914Z');
    expect(parseTimestamp('2026-10-02T00:09:04.914Z')).toBe('2026-10-02T00:09:04.914Z');
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it('extractSelftext reads the text-body slot and normalizes whitespace', async () => {
    const attr = (name: string): string | null =>
      ({ id: 't3_x1', permalink: '/r/x/comments/x1/y/' })[name] ?? null;
    const withBody = {
      tagName: 'shreddit-post',
      ownerDocument: { URL: 'https://www.reddit.com/r/x/' },
      getAttribute: attr,
      querySelector: () => ({ textContent: 'full body text' }),
    };
    const withoutBody = { ...withBody, querySelector: () => null };
    const a = extractPostRecord(withBody, { capturedAtMs: 1 });
    const b = extractPostRecord(withoutBody, { capturedAtMs: 1 });
    expect(a!.selftext).toBe('full body text');
    expect('selftext' in b!).toBe(false);
    expect(await observationId(a!)).not.toBe(await observationId(b!));
  });

  it('recordFromApiPost normalizes a reddit t3 entry', () => {
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
    expect(record!.post_id).toBe('t3_1wcbid7');
    expect(record!.contributed_by).toBe('tap');
    expect(record!.selftext).toBe('the release notes body');
    expect(record!.metrics.comments).toBe(87);
    expect(record!.post_at).toBe(new Date(1790930000500).toISOString());
    expect(recordFromApiPost({ id: 'x' })).toBeNull();
    expect(recordFromApiPost(null)).toBeNull();
    const removed = recordFromApiPost({ ...entry, selftext: '[removed]' });
    expect('selftext' in removed!).toBe(false);
  });

  it('recordFromApiPost keeps reddit preview thumbnails and drops placeholder ones', () => {
    const entry = {
      id: 'abc',
      permalink: '/r/x/comments/abc/',
      thumbnail: 'https://preview.redd.it/pic.jpg?width=640',
    };
    expect(recordFromApiPost(entry)!.thumb_href).toBe('https://preview.redd.it/pic.jpg?width=640');
    expect(recordFromApiPost({ ...entry, thumbnail: 'self' })!.thumb_href).toBeNull();
    expect(recordFromApiPost({ ...entry, thumbnail: 'default' })!.thumb_href).toBeNull();
    expect(recordFromApiPost({ id: 'abc', permalink: '/r/x/comments/abc/' })!.thumb_href).toBeNull();
  });

  it('postsFromApiPayload walks nested listings and dedupes', () => {
    const post = (id: string, extra: Record<string, unknown> = {}): unknown => ({
      kind: 't3',
      data: { id, title: 't', permalink: '/r/x/comments/' + id + '/', ...extra },
    });
    const payload = [{ data: { children: [post('a')] } }, { data: { children: [post('a'), post('b')] } }];
    const records = postsFromApiPayload(payload, { capturedAtMs: 7 });
    expect(records.length).toBe(2);
    expect(records[0]!.post_id).toBe('t3_a');
    expect(records[1]!.post_id).toBe('t3_b');
  });

  it('exactCounter accepts only safe digit strings', () => {
    expect(exactCounter('85')).toBe(85);
    expect(exactCounter('-3')).toBeNull();
    expect(exactCounter('0')).toBe(0);
    expect(exactCounter('abc')).toBeNull();
    expect(exactCounter(null)).toBeNull();
  });
});
