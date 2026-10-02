// Append-only segment log over the private redtap-data Bucket, mirroring
// xtap-pool's immutable Bucket log contract in miniature:
//
//   v1/segments/post/<YYYY>/<MM>/<DD>/<seq>-<uuid>-<sha256(body)>.json.gz
//
// Each batch is one gzipped JSONL segment. Deduplication uses a seen-set
// object (v1/seen.json) that is rewritten on every batch; the segments
// themselves are never modified.
import { createHash, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { downloadFile, listFiles, uploadFile } from "@huggingface/hub";

const gzipAsync = promisify(gzip);

const REPO = { type: "bucket", name: "osolmaz/redtap-data" } as const;
const SEEN_PATH = "v1/seen.json";
const MAX_SEEN = 200_000;

export type PooledRecord = Readonly<Record<string, unknown>>;

export type BucketLog = Readonly<{
  loadSeen: () => Promise<Set<string>>;
  appendSegment: (lines: readonly PooledRecord[]) => Promise<{
    path: string;
    transactionId: string;
    count: number;
  }>;
  saveSeen: (seen: Set<string>) => Promise<void>;
  totalRecords: () => Promise<number>;
}>;

let sequence = 0;

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function openBucketLog(hubArgs: {
  accessToken: string;
}): Promise<BucketLog> {
  const hub = { ...hubArgs, repo: REPO } as const;

  const loadSeen = async (): Promise<Set<string>> => {
    try {
      const blob = await downloadFile({ ...hub, path: SEEN_PATH });
      const parsed = JSON.parse(await blob.text()) as { ids?: string[] };
      return new Set(Array.isArray(parsed.ids) ? parsed.ids : []);
    } catch {
      return new Set();
    }
  };

  const saveSeen = async (seen: Set<string>): Promise<void> => {
    const ids = [...seen].slice(-MAX_SEEN);
    const body = JSON.stringify({ version: 1, ids });
    await uploadFile({
      ...hub,
      path: SEEN_PATH,
      content: body,
    });
  };

  const appendSegment = async (lines: readonly PooledRecord[]) => {
    sequence += 1;
    const now = new Date();
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const compressed = await gzipAsync(body);
    const transactionId = randomUUID();
    const day = now.toISOString().slice(0, 10).replace(/-/g, "/");
    const stamp = String(now.getTime()).padStart(13, "0");
    const path = (
      `v1/segments/post/${day}/${stamp}-${transactionId}-${sha256(body)}.json.gz`
    );
    await uploadFile({
      ...hub,
      path,
      content: Buffer.from(compressed),
    });
    return { path, transactionId, count: lines.length };
  };

  const totalRecords = async (): Promise<number> => {
    let total = 0;
    for await (const file of listFiles({ ...hub, paths: true })) {
      if (typeof file === "object" && "path" in file && String(file.path).includes("/segments/post/")) {
        total += 1;
      }
    }
    return total;
  };

  return { loadSeen, appendSegment, saveSeen, totalRecords };
}
