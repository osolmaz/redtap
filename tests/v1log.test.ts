import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bodyHash,
  EMPTY_BODY_HASH,
  fromV1Lines,
  hashesOf,
  parseV1Text,
  toV1Lines,
  type Digest,
  type ObservationRecord,
} from '../extension/src/lib/v1log.ts';

// Node digest implementation matching the worker's crypto.subtle path.
const digest: Digest = (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex'));

const record = (
  over: Partial<Omit<ObservationRecord, 'metrics'>> & {
    metrics?: Partial<ObservationRecord['metrics']>;
  } = {},
): ObservationRecord => ({
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
  metrics: { score: 376, comments: 86, upvote_ratio: 0.97, ...over.metrics },
  ...(() => {
    const { metrics: _metrics, ...rest } = over;
    return rest;
  })(),
});

describe('v1log', () => {
  it('bodyHash hashes only the selftext and is empty-safe', async () => {
    const a = await bodyHash(record(), digest);
    expect(a.length).toBe(64);
    expect(a).toBe(await bodyHash(record(), digest));
    expect(a).not.toBe(await bodyHash(record({ selftext: 'different' }), digest));
    expect(await bodyHash(record({ selftext: undefined }), digest)).toBe(EMPTY_BODY_HASH);
    expect(await bodyHash(record({ selftext: '[removed]' }), digest)).toBe(EMPTY_BODY_HASH);
  });

  it('toV1Lines emits one body line per distinct hash and a sight per record', async () => {
    const known = new Set<string>();
    const batch1 = await toV1Lines(
      [
        record(),
        record({
          captured_at: 1791439128748,
          observation_id: 'rt_def456',
          metrics: { score: 380, comments: 90 },
        }),
      ],
      known,
      digest,
    );
    expect(batch1.filter((l) => l.k === 'body').length).toBe(1);
    expect(batch1.filter((l) => l.k === 'sight').length).toBe(2);
    const body = batch1.find((l) => l.k === 'body')!;
    expect(body.selftext.includes('## About')).toBe(true);
    expect((body as { title?: unknown }).title).toBeUndefined();
    const sights = batch1.filter((l) => l.k === 'sight');
    expect(sights[0]!.title).toBe(record().title);
    expect(sights[0]!.post_at).toBe(record().post_at);
    expect([...new Set(sights.map((l) => l.h))]).toEqual([body.h]);

    // a second batch with an unchanged body emits no body line when the hash is known
    const knownAfter = new Set([...known, ...hashesOf(batch1)]);
    const batch2 = await toV1Lines(
      [
        record({
          captured_at: 1791439128749,
          observation_id: 'rt_ghi789',
          metrics: { score: 400, comments: 95 },
        }),
      ],
      knownAfter,
      digest,
    );
    expect(batch2.filter((l) => l.k === 'body').length).toBe(0);
    expect(batch2.length).toBe(1);

    // an edited body is a new hash -> a new body line
    const batch3 = await toV1Lines(
      [
        record({
          captured_at: 1791439128750,
          observation_id: 'rt_jkl012',
          selftext: 'edited body',
          metrics: { score: 401, comments: 96 },
        }),
      ],
      knownAfter,
      digest,
    );
    expect(batch3.filter((l) => l.k === 'body').length).toBe(1);
  });

  it('bodyless records reference the empty hash and carry no body line', async () => {
    const lines = await toV1Lines([record({ selftext: undefined })], new Set(), digest);
    expect(lines.length).toBe(1);
    expect(lines[0]!.k).toBe('sight');
    expect(lines[0]!.h).toBe(EMPTY_BODY_HASH);
    expect(hashesOf(lines).size).toBe(0);
  });

  it('fromV1Lines expands back into v1-shaped records', async () => {
    const lines = await toV1Lines(
      [
        record(),
        record({
          captured_at: 1791439128748,
          observation_id: 'rt_def456',
          selftext: 'edited body',
          metrics: { score: 400, comments: 95 },
        }),
      ],
      new Set(),
      digest,
    );
    const records = fromV1Lines(lines);
    expect(records.length).toBe(2);
    const [first, second] = records;
    expect(first!.observation_id).toBe('rt_abc123');
    expect(first!.subreddit).toBe('r/LocalLLaMA');
    expect(second!.selftext).toBe('edited body');
    expect(second!.metrics.score).toBe(400);
    expect(second!.title).toBe('google/embeddinggemma-2 · Hugging Face');
    // a bodyless sighting keeps its metadata through the round trip
    const naked = await toV1Lines(
      [record({ selftext: undefined, observation_id: 'rt_nkd001', title: 'just a link post' })],
      new Set(),
      digest,
    );
    const back = fromV1Lines(naked)[0]!;
    expect(back.title).toBe('just a link post');
    expect(back.selftext).toBeUndefined();
    expect(second!.permalink).toBe('/r/LocalLLaMA/comments/1wz5va3/');
    // the renderer reads these fields on every record
    for (const key of [
      'observation_id',
      'post_id',
      'captured_at',
      'source_endpoint',
      'contributed_by',
      'metrics',
    ]) {
      expect(records[0]![key as keyof ObservationRecord]).not.toBeUndefined();
    }
  });

  it('sight lines skip empty fields and carry optional metadata', async () => {
    const lines = await toV1Lines(
      [
        record({
          author: null,
          selftext: undefined,
          pooled_at: 42,
          metrics: { score: null, comments: null, upvote_ratio: null },
        }),
      ],
      new Set(),
      digest,
    );
    const sight = lines[0]!;
    expect(sight.k).toBe('sight');
    if (sight.k !== 'sight') throw new Error('expected a sight line');
    expect(sight.author).toBeUndefined();
    expect(sight.pooled_at).toBe(42);
    expect(sight.score).toBeUndefined();
  });

  it('records without ids are dropped', async () => {
    const lines = await toV1Lines([record({ post_id: '' })], new Set(), digest);
    expect(lines.length).toBe(0);
  });

  it('parseV1Text skips malformed lines', () => {
    const sight = JSON.stringify({
      k: 'sight',
      oid: 'a',
      post_id: 't3_x',
      t: 1,
      src: '/api/tap',
      by: 'tap',
      h: EMPTY_BODY_HASH,
    });
    const body = JSON.stringify({ k: 'body', h: 'x', selftext: '' });
    expect(parseV1Text(sight + '\nnot json\n\n' + body + '\n').length).toBe(2);
  });

  it('body hash is deterministic', async () => {
    const h = await bodyHash(record(), digest);
    expect(h).toBe(await bodyHash(record(), digest));
    expect(h.length).toBe(64);
  });
});
