// redtap-space: the ingest API for the redtap browser extension.
//
// Mirror of the xtap-pool ingest contract in miniature: bearer-token auth,
// schema validation, dedupe by observation id, append to the immutable
// private Bucket log. Single-pool edition: the pool token is the Space's
// POOL_TOKEN secret, saved once in the extension's options.
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { renderBrowsePage } from "./browse.ts";
import { renderRss } from "./rss.ts";
import { openBucketLog, type BucketLog } from "./bucket-log.ts";
import { RecordStore } from "./record-store.ts";

export const recordSchema = z
  .object({
    observation_id: z.string().regex(/^rt_[a-f0-9]{24}$/u),
    post_id: z.string().regex(/^t3_[a-z0-9]+$/iu),
    post_at: z.string().nullable(),
    captured_at: z.number(),
    source_endpoint: z.string(),
    contributed_by: z.string().min(1),
    pooled_at: z.number().nullable().optional(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    subreddit: z.string().nullable(),
    permalink: z.string(),
    post_type: z.string().nullable(),
    thumb_href: z.string().nullable().optional(),
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
  poolSubreddits?: string;
}>;

export function createApp(config: Config, log: BucketLog, store?: RecordStore) {
  const app = new Hono();
  const seen = new Set<string>();
  let seenLoaded = false;
  const recordStore = store ?? new RecordStore();

  // The pool serves one configured subreddit focus (default r/LocalLLaMA).
  const poolSubreddits = (config.poolSubreddits ?? "LocalLLaMA")
    .split(",")
    .map((s) => s.trim().replace(/^r\//i, "").toLowerCase())
    .filter(Boolean);
  const inPool = (p: { subreddit: string | null }): boolean => {
    if (p.subreddit === null || p.subreddit === "") return false;
    const bare = p.subreddit.replace(/^r\//i, "").toLowerCase();
    return poolSubreddits.includes(bare);
  };
  const visiblePosts = () => recordStore.posts().filter(inPool);

  const ensureSeen = async (): Promise<void> => {
    if (seenLoaded) return;
    const loaded = await log.loadSeen();
    for (const id of loaded) seen.add(id);
    seenLoaded = true;
  };

  const authorized = (header: string | undefined): boolean =>
    header === `Bearer ${config.poolToken}`;

  const favicon = readFileSync(new URL("../static/icon48.png", import.meta.url));
  app.get("/favicon.ico", (c) => c.body(new Uint8Array(favicon), 200, { "content-type": "image/png" }));
  app.use("/static/*", serveStatic({ root: "./static" }));

  app.get("/rss.xml", async (c) => {
    await recordStore.ensureLoaded(config.hubToken);
    const origin = c.req.url.slice(0, c.req.url.indexOf("/", 8)).replace(/^http:/, "https:");
    return c.body(renderRss(visiblePosts(), origin), 200, {
      "content-type": "application/rss+xml; charset=utf-8",
    });
  });


  app.get("/api/posts", async (c) => {
    await recordStore.ensureLoaded(config.hubToken);
    return c.json({ posts: visiblePosts() });
  });

  app.get("/api/status", async (c) => {
    await ensureSeen();
    return c.json({ seen: seen.size, segments: await log.totalRecords() });
  });

  const telemetry: Array<Record<string, unknown>> = [];
  app.post("/api/telemetry", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "invalid or missing pool token" }, 401);
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (payload && typeof payload === "object") {
      telemetry.push(payload as Record<string, unknown>);
      if (telemetry.length > 30) telemetry.shift();
    }
    return c.json({ ok: true });
  });

  app.get("/api/telemetry", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "invalid or missing pool token" }, 401);
    }
    return c.json({ heartbeats: telemetry });
  });

  let controlCache: { at: number; doc: Record<string, unknown> | null } = { at: 0, doc: null };
  app.get("/api/control", async (c) => {
    if (!authorized(c.req.header("authorization"))) {
      return c.json({ error: "invalid or missing pool token" }, 401);
    }
    if (Date.now() - controlCache.at > 30_000) {
      controlCache = { at: Date.now(), doc: await log.readControl() };
    }
    return c.json(controlCache.doc ?? {});
  });

  // Reddit-style browse paths: /r/{sub}/{sort}/{range}/ with word ranges
  // (hour..all) or a custom date pair in the path: /r/{sub}/hot/2026-10-01/2026-10-03/.
  // Root shortcuts work too: /new, /top/week. Query params still fill gaps
  // (the date form GETs ?from=&to= onto the scope path).
  const SORT_KEYS = ["hot", "new", "top", "rising"];
  const RANGE_KEYS = ["hour", "day", "week", "month", "year", "all"];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  app.get("*", async (c) => {
    await recordStore.ensureLoaded(config.hubToken);
    const seg = c.req.path.split("/").filter(Boolean);
    let subreddit = "";
    let sort: string | undefined;
    let range: string | undefined;
    const dates: string[] = [];
    if (seg[0] === "r" && seg[1]) {
      subreddit = "r/" + seg[1];
      seg.splice(0, 2);
    }
    for (const s of seg) {
      if (!sort && SORT_KEYS.includes(s)) sort = s;
      else if (!range && dates.length === 0 && RANGE_KEYS.includes(s)) range = s;
      else if (dates.length < 2 && DATE_RE.test(s)) dates.push(s);
    }
    // A single date segment is a Hacker-News-style day page: that day only.
    if (dates.length === 1) dates.push(dates[0]);
    return c.html(
      renderBrowsePage(visiblePosts(), {
        subreddit: c.req.query("subreddit") ?? subreddit,
        sort: c.req.query("sort") ?? sort,
        range: dates.length > 0 ? undefined : (c.req.query("range") ?? range),
        from: c.req.query("from") ?? dates[0],
        to: c.req.query("to") ?? dates[1],
      }, Date.now()),
    );
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
      for (const record of fresh) {
        recordStore.add(record as (typeof fresh)[number] & { pooled_at: number });
      }
    }
    return c.json({ added: fresh.length, duplicates, rejected });
  });

  return app;
}
