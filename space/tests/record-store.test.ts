import { describe, expect, it } from 'vitest';
import { summarize, type StoredRecord } from '../src/record-store.ts';

const sighting = (over: Partial<StoredRecord>): StoredRecord => ({
  observation_id: 'obs-1',
  post_id: 't3_x',
  post_at: '2026-10-10T00:00:00.000Z',
  captured_at: 1000,
  source_endpoint: '/api/tap',
  contributed_by: 'tap',
  pooled_at: null,
  title: 't',
  author: null,
  subreddit: 'LocalLLaMA',
  permalink: '/r/LocalLLaMA/comments/x/',
  metrics: { score: 1, comments: 0, upvote_ratio: null },
  ...over,
});

describe('record store summarize', () => {
  it('aggregates first and last sightings with deltas', () => {
    const summary = summarize([
      sighting({ captured_at: 1000, metrics: { score: 10, comments: 3 } }),
      sighting({ captured_at: 2000, metrics: { score: 12, comments: 5 } }),
    ]);
    expect(summary.score_first).toBe(10);
    expect(summary.score_last).toBe(12);
    expect(summary.score_delta).toBe(2);
    expect(summary.comments_delta).toBe(2);
    expect(summary.observations).toBe(2);
    expect(summary.first_seen).toBe(1000);
    expect(summary.last_seen).toBe(2000);
    expect(summary.post_at).toBe(Date.parse('2026-10-10T00:00:00.000Z'));
  });

  it('ignores out-of-bounds post dates', () => {
    const summary = summarize([sighting({ post_at: '1980-01-01T00:00:00.000Z' })]);
    expect(summary.post_at).toBeNull();
  });
});
