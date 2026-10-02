// redtap-space: the ingest API for the redtap browser extension.
//
// Mirror of the xtap-pool ingest contract in miniature: bearer-token auth,
// schema validation, dedupe by observation id, append to the immutable
// private Bucket log. Single-pool edition: the pool token is the Space's
// POOL_TOKEN secret, saved once in the extension's options.
import { Hono } from "hono";
import { z } from "zod";

import { openBucketLog, type BucketLog } from "./bucket-log.ts";

export const recordSchema = z
  .object({
    observation_id: z.string().regex(/^rt_[a-f0-9]{24}$/u),
    post_id: z.string().regex(/^t3_[a-z0-9]+$/iu),
    post_at: z.string(),
    captured_at: z.number(),
    source_endpoint: z.string(),
    contributed_by: z.string().min(1),
    pooled_at: z.number().nullable().optional(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    subreddit: z.string().nullable(),
    permalink: z.string(),
    post_type: z.string().nullable(),
    metrics: z
      .object({
        score: z.number().nullable(),
        comments: z.number().nullable(),
        upvote_ratio: z.number().nullable(),
      })
      .partial()
      .default({}),
  })
  .passthrough();

const ingestSchema = z.object({
  records: z.array(recordSchema).min(1).max(500),
});

export type Config = Readonly<{
  poolToken: string;
  hubToken: string;
}>;

export function createApp(config: Config, log: BucketLog) {
  const app = new Hono();
  const seen = new Set<string>();
  let seenLoaded = false;

  const ensureSeen = async (): Promise<void> => {
    if (seenLoaded) return;
    const loaded = await log.loadSeen();
    for (const id of loaded) seen.add(id);
    seenLoaded = true;
  };

  const authorized = (header: string | undefined): boolean =>
    header === `Bearer ${config.poolToken}`;

  app.get("/", (c) =>
    c.json({
      service: "redtap-space",
      status: "ok",
      seen: seen.size,
    }),
  );

  app.get("/api/status", async (c) => {
    await ensureSeen();
    return c.json({ seen: seen.size, segments: await log.totalRecords() });
  });

  app.post("/api/ingest", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "invalid or missing pool token" }, 401);
    }
    await ensureSeen();
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = ingestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: "invalid records" }, 400);
    }

    const fresh = [];
    let duplicates = 0;
    let rejected = 0;
    for (const record of parsed.data.records) {
      const id = record.observation_id;
      if (seen.has(id)) {
        duplicates += 1;
        continue;
      }
      seen.add(id);
      fresh.push({ ...record, pooled_at: Date.now() });
    }
    if (fresh.length > 0) {
      await log.appendSegment(fresh);
      await log.saveSeen(seen);
    }
    return c.json({ added: fresh.length, duplicates, rejected });
  });

  return app;
}
