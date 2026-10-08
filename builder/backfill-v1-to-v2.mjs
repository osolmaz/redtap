// Convert the v1 segment log to v2 (bodies once per hash + tiny sight
// lines), then run the equivalence gate: summarize() must produce identical
// per-post output from v1 records and from the v2 expansion.
//
// Usage: node builder/backfill-v1-to-v2.mjs [--token <hfToken>|--token-file <path>] [--bucket osolmaz/redtap-data]
//   Writes v2 segments next to v1 under v2/log/... and prints the gate result.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
import { listFiles, downloadFile, uploadFile } from '@huggingface/hub';
import { bodyHash, fromV2Lines, toV2Lines } from '../extension/lib/v2log.js';

const REPO = { type: 'bucket', name: process.env.RT_BUCKET ?? 'osolmaz/redtap-data' };
const token = (() => {
  const i = process.argv.indexOf('--token');
  if (i > 0) return process.argv[i + 1];
  const j = process.argv.indexOf('--token-file');
  if (j > 0) return process.argv[j + 1] === '-' ? process.stdin : undefined;
  return undefined; // the hub reads its own env/config when omitted
})();

const digest = async (bytes) => createHash('sha256').update(bytes).digest('hex');

function summarizeV1(sightings) {
  const first = sightings[0];
  const last = sightings[sightings.length - 1];
  return {
    first: first.captured_at,
    last: last.captured_at,
    observations: sightings.length,
    score_first: first.metrics?.score ?? null,
    score_last: last.metrics?.score ?? null,
    comments_last: last.metrics?.comments ?? null,
    title: last.title ?? first.title ?? null,
    selftext_sha: createHash('sha256').update(String(last.selftext ?? '')).digest('hex').slice(0, 16),
  };
}

const n = (v) => (v === undefined ? null : v);

async function main() {
  console.error('listing v1 segments...');
  const paths = [];
  for await (const entry of listFiles({ repo: REPO, accessToken: token, recursive: true, path: 'v1/segments/post/', expand: false })) {
    if (typeof entry === 'object' && 'path' in entry && String(entry.path).endsWith('.json.gz')) paths.push(String(entry.path));
  }
  paths.sort();
  console.error(paths.length, 'segments');

  const v1ByPost = new Map(); // post_id -> v1 records (sorted later)
  const seenOids = new Set();
  let lines = 0;
  let done = 0;
  const fetchSegment = async (path) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const blob = await downloadFile({ repo: REPO, accessToken: token, path, xet: false });
        if (!blob) return '';
        const bytes = Buffer.from(await blob.arrayBuffer());
        return path.endsWith('.gz') ? gunzipSync(bytes).toString('utf-8') : bytes.toString('utf-8');
      } catch (error) {
        if (attempt >= 4) throw error;
        console.error(`  retry ${attempt} for ${path}: ${String(error?.message ?? error).slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  };
  for (const path of paths) {
    const text = await fetchSegment(path);
    done += 1;
    if (done % 200 === 0) console.error(`  ${done}/${paths.length} segments...`);
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      if (!record?.post_id || !record?.observation_id) continue;
      if (seenOids.has(record.observation_id)) continue;
      seenOids.add(record.observation_id);
      const list = v1ByPost.get(record.post_id) ?? [];
      list.push(record);
      v1ByPost.set(record.post_id, list);
      lines += 1;
    }
  }
  console.error(lines, 'unique observation lines across', v1ByPost.size, 'posts');

  // v1 summaries: sort each post's sightings by captured_at, summarize
  for (const list of v1ByPost.values()) list.sort((a, b) => a.captured_at - b.captured_at);

  // v2 conversion: hash-set pre-seeded empty (one big batch emits every body once)
  const known = new Set();
  const v2Lines = await toV2Lines([...v1ByPost.values()].flat(), known, digest);
  const v2Records = fromV2Lines(v2Lines);
  const v2ByPost = new Map();
  for (const r of v2Records) {
    const list = v2ByPost.get(r.post_id) ?? [];
    list.push(r);
    v2ByPost.set(r.post_id, list);
  }

  // equivalence gate
  let mismatches = 0;
  for (const [postId, v1List] of v1ByPost) {
    const a = summarizeV1(v1List);
    const v2List = v2ByPost.get(postId) ?? [];
    if (v2List.length === 0) { console.error('GATE FAIL: missing post', postId); mismatches += 1; continue; }
    const b = summarizeV1(v2List);
    const norm = (s) => JSON.stringify({ ...s, selftext_sha: s.selftext_sha });
    if (norm(a) !== norm(b)) {
      // score/comment histories can differ only by null-vs-undefined normalization
      const loose = (x) => JSON.stringify({ ...x, selftext_sha: x.selftext_sha });
      if (loose(a) !== loose(b)) { console.error('GATE FAIL: differs', postId, JSON.stringify(a).slice(0, 120), '!=', JSON.stringify(b).slice(0, 120)); mismatches += 1; }
    }
  }
  for (const postId of v2ByPost.keys()) {
    if (!v1ByPost.has(postId)) { console.error('GATE FAIL: extra post', postId); mismatches += 1; }
  }

  console.error('v2 lines:', v2Lines.length, 'vs v1 lines:', lines, '(compression', (v2Lines.length / Math.max(lines, 1)).toFixed(3) + 'x)');
  console.error('bodies deduped to', v2Lines.filter((l) => l.k === 'body').length, 'lines');

  if (mismatches > 0) {
    console.error('GATE FAILED:', mismatches, 'mismatched posts');
    process.exit(1);
  }
  console.error('GATE PASSED: v2 expansion matches v1 for all', v1ByPost.size, 'posts');

  if (process.argv.includes('--upload')) {
    // one big immutable backfill segment (deterministic content; uuid fixed per day+hour)
    const now = new Date();
    const stamp = String(now.getTime()).padStart(13, '0');
    const day = now.toISOString().slice(0, 10).replace(/-/g, '/');
    const body = v2Lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const path = `v2/log/${day}/${stamp}-backfill.jsonl.gz`;
    const gz = Buffer.from(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    await uploadFile({ repo: REPO, accessToken: token, file: { path, content: new Blob([gz]) }, commitTitle: 'redtap: v1->v2 backfill (' + v1ByPost.size + ' posts)' });
    console.error('uploaded', path);
  }
}

await main();
