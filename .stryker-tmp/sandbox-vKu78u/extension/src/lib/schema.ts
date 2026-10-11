// @ts-nocheck
// Zod schemas for the wire and storage shapes every layer shares: captured
// observations, v1 segment lines, and the bucket control document. Dynamic
// JSON (Reddit payloads, JSONL segments, chrome.storage) enters the codebase
// through these schemas and nowhere else.
function stryNS_9fa48() {
  var g =
    (typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis) ||
    new Function('return this')();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (
    ns.activeMutant === undefined &&
    g.process &&
    g.process.env &&
    g.process.env.__STRYKER_ACTIVE_MUTANT__
  ) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov =
    ns.mutantCoverage ||
    (ns.mutantCoverage = {
      static: {},
      perTest: {},
    });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { z } from 'zod';

/** Empty-body marker: the sha256 of the empty string. */
export const EMPTY_BODY_HASH = stryMutAct_9fa48('0')
  ? ''
  : (stryCov_9fa48('0'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
export const MetricsSchema = z.object(
  stryMutAct_9fa48('1')
    ? {}
    : (stryCov_9fa48('1'),
      {
        score: z.number().int().nullable(),
        comments: z.number().int().nullable(),
        upvote_ratio: z.number().nullable(),
      }),
);
export type Metrics = z.infer<typeof MetricsSchema>;

/** A captured post before identity assignment (extraction, enrichment). */
export const PostRecordSchema = z.object(
  stryMutAct_9fa48('2')
    ? {}
    : (stryCov_9fa48('2'),
      {
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
      }),
);
export type PostRecord = z.infer<typeof PostRecordSchema>;

/** A captured post with its stable observation identity assigned. */
export const ObservationRecordSchema = PostRecordSchema.extend(
  stryMutAct_9fa48('3')
    ? {}
    : (stryCov_9fa48('3'),
      {
        observation_id: z.string(),
      }),
);
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;
export const BodyLineSchema = z.object(
  stryMutAct_9fa48('4')
    ? {}
    : (stryCov_9fa48('4'),
      {
        k: z.literal(stryMutAct_9fa48('5') ? '' : (stryCov_9fa48('5'), 'body')),
        h: z.string(),
        selftext: z.string(),
      }),
);
export type BodyLine = z.infer<typeof BodyLineSchema>;
export const SightLineSchema = z.object(
  stryMutAct_9fa48('6')
    ? {}
    : (stryCov_9fa48('6'),
      {
        k: z.literal(stryMutAct_9fa48('7') ? '' : (stryCov_9fa48('7'), 'sight')),
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
      }),
);
export type SightLine = z.infer<typeof SightLineSchema>;
export const V1LineSchema = z.discriminatedUnion(
  stryMutAct_9fa48('8') ? '' : (stryCov_9fa48('8'), 'k'),
  stryMutAct_9fa48('9') ? [] : (stryCov_9fa48('9'), [BodyLineSchema, SightLineSchema]),
);
export type V1Line = z.infer<typeof V1LineSchema>;

/** The bucket control document: operator-set flags. Unknown fields pass
 * through so the loop-guard stamp covers the whole document. */
export const ControlDocSchema = z.object(
  stryMutAct_9fa48('10')
    ? {}
    : (stryCov_9fa48('10'),
      {
        reload: z.boolean().optional(),
        flush: z.boolean().optional(),
        at: z.string().optional(),
      }),
);
export type ControlDoc = z.infer<typeof ControlDocSchema>;

/** Raw Reddit API t3 entry: fields are present only when reddit feels like it. */
export const ApiPostEntrySchema = z.object(
  stryMutAct_9fa48('11')
    ? {}
    : (stryCov_9fa48('11'),
      {
        id: stryMutAct_9fa48('12') ? z.string().max(1) : (stryCov_9fa48('12'), z.string().min(1)),
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
      }),
);
export type ApiPostEntry = z.infer<typeof ApiPostEntrySchema>;
