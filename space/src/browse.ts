// The browse UI: a Reddit-style feed of pooled posts with momentum.
// Server-rendered, no JavaScript: sort tabs, subreddit filter pills,
// vote-pill cards with expandable bodies.

import type { PostSummary } from "./record-store.js";

type SortKey = "hot" | "new" | "top" | "rising";

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "hot", label: "Hot" },
  { key: "new", label: "New" },
  { key: "top", label: "Top" },
  { key: "rising", label: "Rising" },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function delta(value: number | null): string {
  if (value === null || value === 0) return "";
  return value > 0 ? "+" + value : String(value);
}

function deltaClass(value: number | null): string {
  if (value === null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function sortPosts(posts: PostSummary[], sort: SortKey): PostSummary[] {
  const sorted = [...posts];
  if (sort === "new") {
    sorted.sort((a, b) => b.last_seen - a.last_seen);
  } else if (sort === "top") {
    sorted.sort((a, b) => (b.score_last ?? -1) - (a.score_last ?? -1));
  } else if (sort === "rising") {
    sorted.sort((a, b) => (b.comments_delta ?? -1) - (a.comments_delta ?? -1));
  } else {
    sorted.sort((a, b) => (b.score_delta ?? -1) - (a.score_delta ?? -1));
  }
  return sorted;
}

const BODY_LIMIT = 12_000;

function bodyHtml(p: PostSummary): string {
  if (!p.selftext) return "";
  const text = p.selftext;
  const inner =
    text.length > BODY_LIMIT
      ? `${escapeHtml(text.slice(0, BODY_LIMIT))}\n<details class="more"><summary>show remaining ${text.length - BODY_LIMIT} characters</summary><div class="md">${escapeHtml(text.slice(BODY_LIMIT))}</div></details>`
      : escapeHtml(text);
  return `<details class="body" open><summary>body</summary><div class="md">${inner}</div></details>`;
}

function card(p: PostSummary, now: number, sort: SortKey): string {
  const body = bodyHtml(p);
  const scoreDelta = delta(p.score_delta);
  const commentsDelta = delta(p.comments_delta);
  return `<article class="post">
    <div class="vote">
      <div class="arrow">▲</div>
      <div class="score">${p.score_last ?? "–"}</div>
      <div class="diff ${deltaClass(p.score_delta)}">${scoreDelta || "&nbsp;"}</div>
      <div class="sightings" title="times seen">${p.observations}👁</div>
    </div>
    <div class="content">
      <div class="meta">
        <a class="sub" href="?subreddit=${encodeURIComponent(p.subreddit ?? "")}&amp;sort=${sort}">${escapeHtml(p.subreddit ?? "r/unknown")}</a>
        <span class="sep">·</span>
        <span class="author">u/${escapeHtml(p.author ?? "unknown")}</span>
        <span class="sep">·</span>
        <span class="when" title="first seen">${ago(p.first_seen, now)}</span>
      </div>
      <a class="title" href="https://www.reddit.com${escapeHtml(p.permalink)}">${escapeHtml(p.title ?? p.post_id)}</a>
      ${body}
      <div class="foot">
        <span class="comments">💬 ${p.comments_last ?? "–"}${commentsDelta ? ` <span class="diff ${deltaClass(p.comments_delta)}">(${commentsDelta})</span>` : ""}</span>
        <a class="open" href="https://www.reddit.com${escapeHtml(p.permalink)}">open on reddit ↗</a>
      </div>
    </div>
  </article>`;
}

export function renderBrowsePage(
  posts: PostSummary[],
  filter: string | undefined,
  sort: string | undefined,
  now: number,
): string {
  const activeSort: SortKey = SORTS.some((s) => s.key === sort) ? (sort as SortKey) : "hot";
  const subreddits = [...new Set(posts.map((p) => p.subreddit).filter((s): s is string => s !== null))].sort();
  const visible = filter ? posts.filter((p) => p.subreddit === filter) : posts;
  const rows = sortPosts(visible, activeSort).map((p) => card(p, now, activeSort)).join("\n");

  const tabLinks = SORTS.map(
    (s) =>
      `<a class="tab${s.key === activeSort ? " on" : ""}" href="?${filter ? "subreddit=" + encodeURIComponent(filter) + "&amp;" : ""}sort=${s.key}">${s.label}</a>`,
  ).join("");
  const subLinks = ['<a class="pill' + (filter ? "" : " on") + '" href="?sort=' + activeSort + '">all</a>'].concat(
    subreddits.map(
      (s) =>
        `<a class="pill${s === filter ? " on" : ""}" href="?subreddit=${encodeURIComponent(s)}&amp;sort=${activeSort}">${escapeHtml(s)}</a>`,
    ),
  ).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>redtap pool</title>
  <style>
    * { box-sizing: border-box; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1416; color: #d7dcdc; margin: 0; }
    header { background: #1a1a1b; border-bottom: 1px solid #343536; padding: 10px 20px; display: flex; align-items: center; gap: 14px; position: sticky; top: 0; z-index: 2; }
    .logo { font-weight: 700; font-size: 17px; color: #ff4500; letter-spacing: -0.5px; }
    .logo span { color: #d7dcdc; }
    .count { color: #818384; font-size: 12px; }
    .tabs { display: flex; gap: 4px; margin-left: auto; }
    .tabs a { color: #818384; text-decoration: none; font-size: 13px; font-weight: 700; padding: 6px 12px; border-radius: 999px; }
    .tabs a.on { background: #272729; color: #ff4500; }
    .tabs a:hover { color: #d7dcdc; }
    .wrap { max-width: 740px; margin: 16px auto; padding: 0 12px; }
    .pills { margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { color: #818384; text-decoration: none; font-size: 12px; border: 1px solid #343536; background: #1a1a1b; padding: 4px 10px; border-radius: 999px; }
    .pill.on { color: #ff4500; border-color: #ff4500; }
    .pill:hover { color: #d7dcdc; }
    .post { display: flex; gap: 8px; background: #1a1a1b; border: 1px solid #343536; border-radius: 4px; margin-bottom: 10px; padding: 8px; }
    .post:hover { border-color: #565758; }
    .vote { width: 40px; flex: none; text-align: center; font-size: 12px; color: #d7dcdc; padding-top: 4px; }
    .vote .arrow { color: #ff4500; font-size: 14px; line-height: 1.1; }
    .vote .score { font-weight: 700; font-size: 13px; }
    .vote .diff { font-size: 11px; }
    .vote .diff.up { color: #4ade80; }
    .vote .diff.down { color: #f87171; }
    .vote .diff.flat { color: #343536; }
    .vote .sightings { color: #818384; font-size: 10px; margin-top: 4px; }
    .content { flex: 1; min-width: 0; }
    .meta { color: #818384; font-size: 12px; margin-bottom: 4px; }
    .meta .sub { color: #d7dcdc; text-decoration: none; font-weight: 700; }
    .meta .sub:hover { color: #ff4500; }
    .meta .sep { margin: 0 4px; }
    .title { display: inline-block; color: #d7dcdc; text-decoration: none; font-size: 17px; font-weight: 500; margin: 2px 0 4px; }
    .title:hover { color: #ff4500; }
    details.body { margin: 6px 0 2px; }
    details.body summary { cursor: pointer; color: #818384; font-size: 12px; }
    details.body .md { white-space: pre-wrap; color: #c3cfd8; font-size: 13px; background: #16181a; border: 1px solid #272729; border-radius: 4px; padding: 8px 10px; margin-top: 4px; }
    details.body summary { list-style: none; }
    details.body summary::before { content: "▾ "; color: #818384; }
    details.body:not([open]) summary::before { content: "▸ "; }
    details.body[open] summary { margin-bottom: 2px; }
    details.body .more { margin-top: 6px; }
    details.body .more summary { cursor: pointer; color: #4f8cc7; font-size: 12px; padding: 2px 0; }
    details.body .more .md { margin-top: 4px; }
    .foot { display: flex; gap: 16px; align-items: center; margin-top: 8px; font-size: 12px; color: #818384; }
    .foot .open { color: #ff4500; text-decoration: none; font-weight: 700; }
    .foot .open:hover { text-decoration: underline; }
    .empty { color: #818384; text-align: center; padding: 40px 0; }
  </style>
</head>
<body>
  <header>
    <div class="logo">redtap <span>pool</span></div>
    <div class="count">${posts.length} posts · ${escapeHtml(String(subreddits.length))} subs</div>
    <nav class="tabs">${tabLinks}</nav>
  </header>
  <div class="wrap">
    <div class="pills">${subLinks}</div>
    ${rows || '<div class="empty">nothing pooled yet</div>'}
  </div>
</body>
</html>`;
}
