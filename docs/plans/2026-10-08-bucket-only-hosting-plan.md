# Bucket-only hosting plan (no Space)

Consulted design: Claude Opus 5.5, 2026-10-08. Goal: redtap runs with no
Hugging Face Space — the extension writes to the bucket directly, a GitHub
Actions builder pre-renders the site, GitHub Pages serves it. The plan below
is the consultant's design verbatim, plus our step 0 probes and acceptance
gates.

## Step 0 — probes (must pass before anything else)

1. Bundle `@huggingface/hub` `uploadFile({ type: 'bucket' })` in a MV3 service
   worker context (Playwright-loaded unpacked extension is fine) and commit a
   tiny test object to `osolmaz/redtap-data`. If WASM is required, verify
   `'wasm-unsafe-eval'` CSP suffices.
2. Create a fine-grained token scoped to only `osolmaz/redtap-data` with
   bucket write; confirm it can commit and cannot read other repos.

## Acceptance gates

- Backfill: v1 -> v2 conversion where `summarize()` output is identical per
  post from v1 and from v2 (a scripted gate, all posts).
- Render parity: 20 sample routes (sort x scope, day pages, one post page,
  feed.xml) byte-comparable or semantically equal to the live Space output.
- Extension: unit tests pass; a Playwright end-to-end writes one v2 segment
  to a scratch bucket; the outbox retries an injected failure once.
- Cutover and rollback follow section 5; production deploys happen only with
  Onur's explicit go after PR review.

---

I recommend this design: the extension is the only writer to the bucket, and the bucket stays private. A scheduled GitHub Actions job is the only reader. It builds a static site and RSS and deploys them to GitHub Pages. No public browser reads the bucket.

## 1. Ingest: extension to bucket

- **Endpoint shape.** A bucket write is not one PUT. It is a Xet upload in three steps: get a Xet write token from the Hub, upload the xorb and shard to the Xet CAS, then commit the path-to-hash map through the Hub bucket API. The `PUT` in your preflight is probably the CAS step. Do not write your own client. Bundle `@huggingface/hub` in the service worker; `space/src/bucket-log.ts` already calls `uploadFile` with `{type:"bucket"}`.
- **MV3.** Add `host_permissions` for `huggingface.co` and the Xet CAS hosts. With host permissions, extension fetches skip CORS, so the CORS headers do not matter for ingest. If the bundle loads WASM, add `'wasm-unsafe-eval'` to the extension CSP.
- **Batching.** Stop the 30 s flushes. Write captures to an IndexedDB outbox. Seal one batch per 2 h cycle and give it a fixed UUID path. Upload it from `chrome.alarms`. A retry uses the same path and the same bytes, so a retry is safe to repeat.
- **Failures.** Use exponential backoff with jitter, and obey `Retry-After` on 429. On 401 or 403, stop, show a red badge, and keep buffering for up to 30 days. About 12 writes per day is far below Hub limits.
- **Token.** Create a new fine-grained write token for `osolmaz/redtap-data` only, and keep it in `chrome.storage.local`. Do not reuse the Space token. If fine-grained scope cannot target one bucket, move the bucket to a namespace that holds nothing else. Buckets keep no history, so a leaked token can delete data. Add a weekly `hf buckets sync` to local disk as a backup.
- **Dedupe.** Remove `v1/seen.json`, a shared file that every batch rewrites. The extension dedupes from IndexedDB, and the builder dedupes by `observation_id`.

## 2. Storage layout

```
v2/log/YYYY/MM/DD/<ts13>-<uuid>.jsonl.gz   immutable; written by the extension
v2/control.json                             written by you (hf buckets cp); read by the extension
v1/                                         frozen until the rollback window ends
```

A segment has two kinds of line:
- `body`: `h`, `post_id`, title, selftext, author, subreddit, post_at, permalink, content_href, thumb_href, post_type
- `sight`: `oid`, `post_id`, `t`, `src`, `by`, score, comments, ratio, `h`

`h` is the SHA-256 of the canonical body JSON. The extension writes a `body` line only when `h` is not in its known-hash set. It adds `h` to the set only after a successful commit. So every sighting finds its body in the same segment or an earlier one. An edit gives a new hash, so edit history is free. Also skip a sighting when score and comments did not change. I expect about 10× less data; measure it on the backfill. At 12 files per day, you need no compaction for years.

## 3. Read path, UI and RSS

- **Do not serve HTML from the bucket.** The bucket is private, reads redirect to signed CDN URLs, and it has no index routing or custom domain. A bucket is storage, not hosting.
- **Builder.** A GitHub Actions cron at `17 */2 * * *`, plus `workflow_dispatch`. It reads with a read-only token kept as an Actions secret, which needs your approval. A public bucket removes the secret but exposes `contributed_by`. `actions/cache` keeps parsed state and the list of processed segments, so each run downloads only new segments.
- **Rendering.** Reuse `browse.ts`, `chart.ts`, `md.ts` and `rss.ts` as plain render functions. Write out every Space route with the same paths: sort × scope pages, `day/…`, `p/<id>/` and `feed.xml`.
- **Status.** A banner that shows the newest segment time replaces the telemetry sink.

## 4. What becomes worse

- New data takes up to 2 h plus cron delay to show, and GitHub sometimes runs cron late or skips it.
- Only precomputed sorts and scopes work. Free queries need client-side JS over a JSON index.
- The zod checks move into the extension (before it seals a batch) and into the builder, which sets bad lines aside and does not fail.
- Only token holders can write, so there is no multi-user ingest.
- Pages on a private repo needs a paid GitHub plan. On a public repo, GitHub turns off cron after 60 days with no activity, so let the build commit a small file each month.
- Old `*.hf.space` links stop working.

## 5. Migration

1. **Approvals:** Pages repo visibility, two new tokens, and the Actions secret.
2. **Backfill:** a local script converts `v1/` to `v2/log/` and keeps the original dates. Gate: `summarize()` must give the same result for each post from v1 and from v2.
3. **Builder:** compare 20 sample pages and the feed with the live Space, then deploy to Pages.
4. **Cutover:** ship the extension that writes v2 directly, and tag the old version `pre-direct`. Pause the Space; do not delete it.
5. **Watch for 7 days:** one segment per cycle, an empty outbox, green builds, and a fresh banner.
6. **Rollback during that window:** reinstall `pre-direct`, unpause the Space, and convert the gap segments back to v1.
7. **After 14 clean days:** with your OK, delete the Space, revoke its token, and remove `space/` and `v1/` (19 MB).

Before you build, check two things that I could not confirm: the exact Xet upload endpoints, and whether a fine-grained token can target one bucket. Shell commands needed approval in this session, so I read only the Space source. The rest of the design does not change if either answer differs.
