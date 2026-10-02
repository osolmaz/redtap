# redtap

Passively captures Reddit posts as you browse and saves them locally as JSONL —
along the lines of [xTap](https://github.com/mkubicek/xTap), for Reddit.

## What it does

- A content script watches Reddit's server-rendered `shreddit-post` web
  components (the feed and every page that shows posts) and captures the full
  post payload: id, title, author, subreddit, score, comment count,
  upvote ratio, timestamps, permalink, post type, and link metadata.
- Captures are normalized to a JSONL-friendly record (transport fields mirror
  xTap: `captured_at`, `pooled_at`, `contributed_by`, `source_endpoint`,
  `observation_id`, `metrics`), deduplicated by stable observation identity,
  and sampled when unchanged re-sightings arrive (5-minute gate).
- The popup shows capture counts and exports the unique-post JSONL via the
  downloads API (`redtap/redtap-<timestamp>.jsonl`).
- An `externally_connectable` bridge implements the same `xtap-scrape-v1`
  protocol the [Infinite Feed Scroller](https://github.com/osolmaz/infinite-feed-scroller)
  uses with xTap, so the scroller can drive Reddit scrape jobs with subreddit
  feeds playing the role of X lists.
- **Pool sync** mirrors xtap-pool: observations queue in the extension and
  flush in batches with backoff to `space/` (a Hugging Face Docker Space,
  deployed from this same repo via `scripts/deploy-space.sh`), which dedupes
  by observation id and appends gzipped JSONL segments to the private
  immutable Bucket log `osolmaz/redtap-data` (`v1/segments/post/…`). Configure
  the Space URL + `POOL_TOKEN` in the extension options.


## Why DOM capture

Reverse engineering (see `docs/REVERSE-ENGINEERING.md`): new Reddit
server-side renders every post as a `<shreddit-post>` web component with the
full payload in attributes, while the `.json` API answers 403 to non-browser
clients. Capturing the DOM inside the real browser is therefore both the most
reliable and the most polite path — the same conclusion xTap reached for X.

## Install (personal use)

1. `chrome://extensions` → Developer mode → **Load unpacked** → select
   `extension/`.
2. Browse Reddit. The popup shows capture counts; **Export JSONL** writes the
   unique-post file to your downloads directory.

## Status

Private, personal-use project. See `docs/REQUIREMENTS.md` for the original
requirements and `docs/REVERSE-ENGINEERING.md` for the Reddit recon.
