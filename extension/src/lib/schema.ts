// Zod schemas for the wire and storage shapes every layer shares: captured
// observations, v1 segment lines, and the bucket control document. Dynamic
// JSON (Reddit payloads, JSONL segments, chrome.storage) enters the codebase
// through these schemas and nowhere else.
import { z } from 'zod';

/** Empty-body marker: the sha256 of the empty string. */
export const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const MetricsSchema = z.object({
  score: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  upvote_ratio: z.number().nullable(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

/** A captured post before identity assignment (extraction, enrichment). */
export const PostRecordSchema = z.object({
  post_id: z.string(),
  post_at: z.string().nullable(),
  captured_at: z.number(),
  source_endpoint: z.string(),
  contributed_by: z.string(),
  pooled_at: z.number().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  author_id: z.string().nullable().optional(),
  subreddit: z.string().nullable(),
  subreddit_id: z.string().nullable().optional(),
  permalink: z.string(),
  post_type: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  content_href: z.string().nullable(),
  thumb_href: z.string().nullable().optional(),
  view_context: z.string().nullable().optional(),
  award_count: z.number().nullable().optional(),
  selftext: z.string().optional(),
  metrics: MetricsSchema,
});
export type PostRecord = z.infer<typeof PostRecordSchema>;

/** A captured post with its stable observation identity assigned. */
export const ObservationRecordSchema = PostRecordSchema.extend({
  observation_id: z.string(),
});
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;

export const BodyLineSchema = z.object({
  k: z.literal('body'),
  h: z.string(),
  selftext: z.string(),
});
export type BodyLine = z.infer<typeof BodyLineSchema>;

export const SightLineSchema = z.object({
  k: z.literal('sight'),
  oid: z.string(),
  post_id: z.string(),
  t: z.number(),
  src: z.string(),
  by: z.string(),
  h: z.string(),
  pooled_at: z.number().optional(),
  post_at: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  subreddit: z.string().nullable().optional(),
  permalink: z.string().nullable().optional(),
  content_href: z.string().nullable().optional(),
  thumb_href: z.string().nullable().optional(),
  post_type: z.string().nullable().optional(),
  score: z.number().optional(),
  comments: z.number().optional(),
  ratio: z.number().optional(),
});
export type SightLine = z.infer<typeof SightLineSchema>;

export const V1LineSchema = z.discriminatedUnion('k', [BodyLineSchema, SightLineSchema]);
export type V1Line = z.infer<typeof V1LineSchema>;

/** The bucket control document: operator-set flags. Unknown fields pass
 * through so the loop-guard stamp covers the whole document. */
export const ControlDocSchema = z.object({
  reload: z.boolean().optional(),
  flush: z.boolean().optional(),
  at: z.string().optional(),
});
export type ControlDoc = z.infer<typeof ControlDocSchema>;

/** Raw Reddit API t3 entry: fields are present only when reddit feels like it. */
export const ApiPostEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  author: z.string().optional(),
  author_fullname: z.string().optional(),
  subreddit: z.string().optional(),
  subreddit_id: z.string().optional(),
  subreddit_name_prefixed: z.string().optional(),
  permalink: z.string().optional(),
  created_utc: z.number().optional(),
  score: z.number().optional(),
  num_comments: z.number().optional(),
  upvote_ratio: z.number().optional(),
  is_self: z.boolean().optional(),
  selftext: z.string().optional(),
  post_hint: z.string().optional(),
  domain: z.string().optional(),
  url_overridden_by_dest: z.string().optional(),
  thumbnail: z.string().optional(),
  total_awards_received: z.number().optional(),
});
export type ApiPostEntry = z.infer<typeof ApiPostEntrySchema>;
