// Shared fixture: a tiny v2 log (two posts, one with two sightings) written to
// a bucket-root-mirror folder layout, plus helpers to load the server state.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toV2Lines } from '../../extension/lib/v2log.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// the renderer filters by windows relative to now (24h for the daily scope
// and rss), so the fixture must be recent — never pin a fixed date here
export const POST_AT_MS = Date.now() - 3600_000;
export const POST_AT = new Date(POST_AT_MS).toISOString();
export const POST_DAY = new Date(POST_AT_MS).toISOString().slice(0, 10);

const baseRecord = {
  post_id: 't3_fix000',
  post_at: POST_AT,
  source_endpoint: 'fixture',
  contributed_by: 'test',
  title: 'Fixture post',
  author: 'fixer',
  subreddit: 'LocalLLaMA',
  permalink: '/r/LocalLLaMA/comments/fix000/',
  content_href: 'https://www.reddit.com/r/LocalLLaMA/comments/fix00/',
  post_type: 'text',
  metrics: { score: 10, comments: 3, upvote_ratio: 0.9 },
};

export function fixtureRecords() {
  return [
    { ...baseRecord, observation_id: 'obs-1', captured_at: POST_AT_MS,
      selftext: JSON.stringify({ document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello fixture body' }] }] } }) },
    { ...baseRecord, observation_id: 'obs-2', captured_at: POST_AT_MS + 60_000,
      metrics: { score: 12, comments: 5, upvote_ratio: 0.9 } },
    { ...baseRecord, post_id: 't3_fix001', observation_id: 'obs-3', captured_at: POST_AT_MS + 120_000,
      title: 'Second fixture post', selftext: undefined,
      metrics: { score: 1, comments: 0, upvote_ratio: 0.6 } },
  ];
}

/** Write a bucket-root mirror (v2/log/ segments) and return its path. */
export async function makeBucketMirror() {
  const root = mkdtempSync(join(tmpdir(), 'redtap-serve-fixture-'));
  const lines = await toV2Lines(fixtureRecords(), new Set(), digest);
  const segDir = join(root, 'v2', 'log', ...new Date(POST_AT_MS).toISOString().slice(0, 10).split('-'));
  mkdirSync(segDir, { recursive: true });
  writeFileSync(join(segDir, POST_AT_MS + '-fixture.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return root;
}
