// In-memory record store for the browse UI: every pooled observation, with
// per-post aggregation for the momentum view (first/last sighting, score and
// comment deltas). Rebuilt from the Bucket segments at boot, updated on ingest.
import { downloadFile, listFiles } from "@huggingface/hub";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

const REPO = { type: "bucket", name: "osolmaz/redtap-data" } as const;

export type StoredRecord = {
  observation_id: string;
  post_id: string;
  post_at: string | null;
  captured_at: number;
  source_endpoint: string;
  contributed_by: string;
  pooled_at: number | null;
  title: string | null;
  author: string | null;
  subreddit: string | null;
  permalink: string;
  selftext?: string | null;
  metrics: { score?: number | null; comments?: number | null; upvote_ratio?: number | null };
};

export type PostSummary = {
  post_id: string;
  subreddit: string | null;
  title: string | null;
  author: string | null;
  permalink: string;
  first_seen: number;
  last_seen: number;
  observations: number;
  score_first: number | null;
  score_last: number | null;
  score_delta: number | null;
  comments_last: number | null;
  comments_delta: number | null;
  selftext: string | null;
};

export class RecordStore {
  private records = new Map<string, StoredRecord>();
  private loaded = false;

  async ensureLoaded(hubToken: string): Promise<void> {
    if (this.loaded) return;
    for await (const entry of listFiles({
      repo: REPO,
      accessToken: hubToken,
      recursive: true,
      path: "v1/segments/post/",
      expand: false,
    })) {
      const path = typeof entry === "object" && "path" in entry ? String(entry.path) : "";
      if (!path.endsWith(".json.gz")) continue;
      try {
        const blob = await downloadFile({ repo: REPO, accessToken: hubToken, path, xet: false });
        if (blob === null) continue;
        const text = (await gunzipAsync(Buffer.from(new Uint8Array(await blob.arrayBuffer())))).toString("utf-8");
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          try {
            const record = JSON.parse(line) as StoredRecord;
            if (record.observation_id) this.records.set(record.observation_id, record);
          } catch {}
        }
      } catch {}
    }
    this.loaded = true;
  }

  add(record: StoredRecord): void {
    this.records.set(record.observation_id, record);
  }

  count(): number {
    return this.records.size;
  }

  posts(): PostSummary[] {
    const byPost = new Map<string, StoredRecord[]>();
    for (const record of this.records.values()) {
      const list = byPost.get(record.post_id) ?? [];
      list.push(record);
      byPost.set(record.post_id, list);
    }
    const summaries: PostSummary[] = [];
    for (const [post_id, sightings] of byPost) {
      sightings.sort((a, b) => a.captured_at - b.captured_at);
      const first = sightings[0];
      const last = sightings[sightings.length - 1];
      const scoreFirst = first.metrics?.score ?? null;
      const scoreLast = last.metrics?.score ?? null;
      const commentsFirst = first.metrics?.comments ?? null;
      const commentsLast = last.metrics?.comments ?? null;
      summaries.push({
        post_id,
        subreddit: last.subreddit ?? first.subreddit ?? null,
        title: last.title ?? first.title ?? null,
        author: last.author ?? first.author ?? null,
        permalink: last.permalink ?? first.permalink ?? "",
        first_seen: first.captured_at,
        last_seen: last.captured_at,
        observations: sightings.length,
        score_first: scoreFirst,
        score_last: scoreLast,
        score_delta:
          scoreFirst !== null && scoreLast !== null ? scoreLast - scoreFirst : null,
        comments_last: commentsLast,
        comments_delta:
          commentsFirst !== null && commentsLast !== null ? commentsLast - commentsFirst : null,
        selftext:
          [...sightings].reverse().map((r) => r.selftext).find((t) => typeof t === "string" && t.length > 0) ?? null,
      });
    }
    return summaries;
  }
}
