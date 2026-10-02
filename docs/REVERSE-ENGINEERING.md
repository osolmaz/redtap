# How Reddit serves post data (reverse engineering, 2026-10-02)

## TL;DR

New Reddit (www.reddit.com and sh.reddit.com) **server-side renders** posts as
`<shreddit-post>` web components with the full post payload in DOM attributes.
No API request is needed to capture what a user sees: the data is already in
the DOM. The classic `.json` endpoints still exist but Reddit returns **403**
for non-browser clients (curl with a browser UA was rejected), so DOM capture
inside the real browser is the reliable path — the same conclusion xTap
reached for X.

## Evidence

- `https://www.reddit.com/r/LocalLLaMA/` (fetched in a real Chrome via CDP)
  renders a `<shreddit-feed>` element containing ~27 `<shreddit-post>`
  elements per feed page, each carrying the full post payload as attributes.
- `curl` of `https://www.reddit.com/r/LocalLLaMA/.json?limit=5` with a desktop
  Chrome User-Agent returns **403** (Reddit blocks non-browser clients).
- Old reddit (`old.reddit.com`) is classic SSR HTML and also exposes `.json`
  endpoints; we target the new UI only.

## The `shreddit-post` attribute payload (the capture contract)

| Attribute | Example | Meaning |
|---|---|---|
| `id` | `t3_1wvffcr` | post fullname (t3_ + base36 id) |
| `post-title` | `Pi 1.0 released - MCP support…` | title |
| `author` | `psychohistorian8` | author username |
| `author-id` | `t2_g4rwz` | author fullname |
| `score` | `85` | score |
| `upvote-ratio` | `0.956989247311828` | upvote ratio |
| `comment-count` | `36` | comment count |
| `subreddit-prefixed-name` | `r/LocalLLaMA` | subreddit |
| `subreddit-id` | `t5_81eyvm` | subreddit fullname |
| `permalink` | `/r/LocalLLaMA/comments/1wvffcr/…` | canonical path |
| `created-timestamp` | `2026-10-02T00:09:04.914000+0000` | post creation time (ISO) |
| `post-type` | `link` \| `text` \| … | post kind |
| `domain` | `earendil.com` | link domain (link posts) |
| `content-href` | `https://earendil.com/posts/pi-1-0/` | external URL (link posts) |
| `feedindex` | `0` | position in the feed |
| `view-context` | `SubredditFeed` | which surface rendered the post |
| `award-count` | `0` | awards |

Comment counts are attributes; comment bodies only exist on comment pages
(`shreddit-comment` elements) and are out of scope for the first version.

## Feed behavior

- `shreddit-feed` appends further `shreddit-post` elements as the user
  scrolls (virtualized infinite feed) — a `MutationObserver` on the feed sees
  every post the scroller walks past.
- Deleted/removed posts appear as different elements (`shreddit-post` removal
  or an `shreddit-post-deleted` wrapper) — treat missing required attributes
  as a skip signal.

## Conclusion for redtap

Capture passively from the DOM exactly like xTap does for tweets:

1. A content script watches `shreddit-feed` subtrees for `shreddit-post`
   elements, reads the attribute payload, and hands a normalized record to the
   service worker.
2. The service worker keeps stable observation identities (canonical hash),
   deduplicates unique posts, samples unchanged re-observations, and appends
   to a local JSONL store.
3. The same scrape-bridge port contract xTap exposes to the Infinite Feed
   Scroller (`xtap-scrape-v1`) is implemented on the Reddit side, with the
   subreddit feed path playing the role of the list id.
