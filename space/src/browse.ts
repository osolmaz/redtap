// The browse UI: a Reddit-style feed of pooled posts with momentum.
// Server-rendered, no JavaScript: sort tabs (hot/new/top/rising), a time
// scope (hour/day/week/month/year/all or a custom date range), subreddit
// filter pills, vote-pill cards with bodies extended by default.

import type { PostSummary } from "./record-store.js";

type SortKey = "hot" | "new" | "top" | "rising";

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "hot", label: "Hot" },
  { key: "new", label: "New" },
  { key: "top", label: "Top" },
  { key: "rising", label: "Rising" },
];

type RangeKey = "hour" | "day" | "week" | "month" | "year" | "all";

const RANGES: ReadonlyArray<{ key: RangeKey; label: string; ms: number }> = [
  { key: "hour", label: "hour", ms: 60 * 60_000 },
  { key: "day", label: "day", ms: 24 * 60 * 60_000 },
  { key: "week", label: "week", ms: 7 * 24 * 60 * 60_000 },
  { key: "month", label: "month", ms: 30 * 24 * 60 * 60_000 },
  { key: "year", label: "year", ms: 365 * 24 * 60 * 60_000 },
  { key: "all", label: "all", ms: Number.POSITIVE_INFINITY },
];

export type BrowseQuery = {
  subreddit?: string | null;
  sort?: string | null;
  range?: string | null;
  from?: string | null;
  to?: string | null;
};

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
    sorted.sort(
      (a, b) => (b.post_at ?? b.last_seen) - (a.post_at ?? a.last_seen),
    );
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

// Direct image links only; gallery or landing pages stay out of the feed.
function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return /\.(jpe?g|png|gif|webp|avif)([?#]|$)/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function bodyHtml(p: PostSummary): string {
  if (!p.selftext) return "";
  const text = p.selftext;
  if (text.length <= BODY_LIMIT) {
    return `<div class="md">${escapeHtml(text)}</div>`;
  }
  return `<div class="md">${escapeHtml(text.slice(0, BODY_LIMIT))}</div>
<details class="more"><summary>show remaining ${(text.length - BODY_LIMIT).toLocaleString("en-US")} characters</summary><div class="md">${escapeHtml(text.slice(BODY_LIMIT))}</div></details>`;
}

const MEDIA_HINT = /video|gallery|image|rich/i;

function imageHtml(p: PostSummary): string {
  // Direct image posts hotlink their own URL; video and gallery posts fall
  // back to reddit's preview thumbnail. Plain link posts get no image —
  // their previews are tiny cards that read as page noise.
  const src =
    p.content_href && isDirectImageUrl(p.content_href)
      ? p.content_href
      : p.post_type && MEDIA_HINT.test(p.post_type) && p.thumb_href && isDirectImageUrl(p.thumb_href)
        ? p.thumb_href
        : null;
  if (!src) return "";
  const link = p.content_href ?? p.permalink;
  return `<a class="imglink" href="${escapeHtml(link)}" target="_blank" rel="noreferrer"><img class="thumb" src="${escapeHtml(src)}" loading="lazy" referrerpolicy="no-referrer" alt="post image" /></a>`;
}

// Reddit was founded in June 2005; sighting times before that are garbage.
const MIN_SANE_MS = Date.parse("2005-06-01T00:00:00.000Z");

function whenLabel(p: PostSummary, now: number): string {
  if (p.post_at !== null) return ago(p.post_at, now);
  if (p.first_seen >= MIN_SANE_MS) return ago(p.first_seen, now);
  return "—";
}

function whenTitle(p: PostSummary): string {
  if (p.post_at !== null)
    return "posted " + new Date(p.post_at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return "first seen " + new Date(p.first_seen).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function card(p: PostSummary, now: number, sort: SortKey): string {
  const body = bodyHtml(p);
  const image = imageHtml(p);
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
        <a class="sub" href="${pageUrl({ subreddit: p.subreddit })}">${escapeHtml(p.subreddit ?? "r/unknown")}</a>
        <span class="sep">·</span>
        <span class="author">u/${escapeHtml(p.author ?? "unknown")}</span>
        <span class="sep">·</span>
        <span class="when" title="${whenTitle(p)}">${whenLabel(p, now)}</span>
      </div>
      <a class="title" href="https://www.reddit.com${escapeHtml(p.permalink)}">${escapeHtml(p.title ?? p.post_id)}</a>
      ${image}
      ${body}
      <div class="foot">
        <span class="comments">💬 ${p.comments_last ?? "–"}${commentsDelta ? ` <span class="diff ${deltaClass(p.comments_delta)}">(${commentsDelta})</span>` : ""}</span>
        <a class="open" href="https://www.reddit.com${escapeHtml(p.permalink)}">open on reddit ↗</a>
      </div>
    </div>
  </article>`;
}

// URL builder preserving the active scope across navigation links.
let pageState: Required<BrowseQuery> = { subreddit: "", sort: "hot", range: "day", from: "", to: "" };

/** Reddit-style path for the current scope: /r/{sub}/{sort}/{range|from/to}/.
 *  Defaults (hot, day, no sub) stay out of the path. */
export function pageUrl(overrides: Partial<BrowseQuery>): string {
  const merged = { ...pageState, ...overrides };
  const parts: string[] = [];
  if (merged.subreddit) parts.push("r/" + merged.subreddit.replace(/^r\//i, ""));
  if (merged.sort && merged.sort !== "hot") parts.push(merged.sort);
  if (merged.from) {
    parts.push(merged.from);
    if (merged.to && merged.to !== merged.from) parts.push(merged.to);
  } else if (merged.range && merged.range !== "day") {
    parts.push(merged.range);
  }
  return "/" + (parts.join("/") ? parts.join("/") + "/" : "");
}

/** Path prefix for form actions: the scope without the date tail. */
function scopeUrl(): string {
  const parts: string[] = [];
  if (pageState.subreddit) parts.push("r/" + pageState.subreddit.replace(/^r\//i, ""));
  if (pageState.sort && pageState.sort !== "hot") parts.push(pageState.sort);
  return "/" + (parts.join("/") ? parts.join("/") + "/" : "");
}

export function renderBrowsePage(
  posts: PostSummary[],
  query: BrowseQuery,
  now: number,
): string {
  const activeSort: SortKey = SORTS.some((s) => s.key === query.sort) ? (query.sort as SortKey) : "hot";
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "") ? (query.from as string) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "") ? (query.to as string) : "";
  const hasDates = from !== "" || to !== "";
  // Explicit dates replace the preset range entirely; the default is daily.
  const activeRange: RangeKey = hasDates
    ? "all"
    : RANGES.some((r) => r.key === query.range)
      ? (query.range as RangeKey)
      : "day";
  pageState = {
    subreddit: query.subreddit ?? "",
    sort: activeSort,
    range: activeRange,
    from,
    to: from !== "" && (to === from || to === "") ? from : to,
  };

  const isDayPage = from !== "" && (to === from || to === "");
  const subreddits = [...new Set(posts.map((p) => p.subreddit).filter((s): s is string => s !== null))].sort();
  const visible = filterPosts(posts, now);

  const rows = sortPosts(visible, activeSort).map((p) => card(p, now, activeSort)).join("\n");

  const tabLinks = SORTS.map(
    (s) =>
      `<a class="tab${s.key === activeSort ? " on" : ""}" href="${pageUrl({ sort: s.key })}">${s.label}</a>`,
  ).join("");
  const rangeLinks = RANGES.map(
    (r) =>
      `<a class="pill${r.key === activeRange && !from && !to ? " on" : ""}" href="${pageUrl({ range: r.key, from: "", to: "" })}">${r.label}</a>`,
  ).join("");
  const subLinks = ['<a class="pill' + (pageState.subreddit ? "" : " on") + '" href="' + pageUrl({ subreddit: "" }) + '">all</a>'].concat(
    subreddits.map(
      (s) =>
        `<a class="pill${s === pageState.subreddit ? " on" : ""}" href="${pageUrl({ subreddit: s })}">${escapeHtml(s)}</a>`,
    ),
  ).join("");
  const scopeLabel =
    isDayPage
      ? ""
      : from || to
        ? `${from || "…"} → ${to || "…"}`
        : activeRange === "all"
        ? ""
        : RANGES.find((r) => r.key === activeRange)?.label ?? "";

  // Hacker-News-style day pages: a single calendar day gets prev/next nav.
  let dayNav = "";
  if (isDayPage) {
    const dayMs = Date.parse(from + "T00:00:00.000Z");
    const dayNum = Number.isFinite(dayMs) ? dayMs / 86_400_000 : NaN;
    if (Number.isFinite(dayNum)) {
      const fmt = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);
      const label = new Date(dayMs).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
      const prev = pageUrl({ range: undefined, from: fmt(dayNum - 1), to: fmt(dayNum - 1) });
      const next = pageUrl({ range: undefined, from: fmt(dayNum + 1), to: fmt(dayNum + 1) });
      const nextIsFuture = fmt(dayNum + 1) > new Date(now).toISOString().slice(0, 10);
      dayNav = `<div class="daynav">
        <a href="${prev}">← prev day</a>
        <span class="daytitle">${escapeHtml(label)}</span>
        ${nextIsFuture ? `<span class="ghost">next day →</span>` : `<a href="${next}">next day →</a>`}
      </div>`;
    }
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>redtap pool</title>
  <link rel="icon" type="image/png" href="/static/icon48.png" />
  <link rel="alternate" type="application/rss+xml" title="redtap pool" href="/rss.xml" />
  <style>
    * { box-sizing: border-box; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1416; color: #d7dcdc; margin: 0; }
    header { background: #1a1a1b; border-bottom: 1px solid #343536; padding: 10px 20px; position: sticky; top: 0; z-index: 2; }
    .headrow { display: flex; align-items: center; gap: 14px; max-width: 740px; margin: 0 auto; }
    .logo { font-weight: 700; font-size: 17px; color: #ff4500; letter-spacing: -0.5px; }
    .logo span { color: #d7dcdc; }
    .count { color: #818384; font-size: 12px; }
    .tabs { display: flex; gap: 4px; margin-left: auto; }
    .tabs a { color: #818384; text-decoration: none; font-size: 13px; font-weight: 700; padding: 6px 12px; border-radius: 999px; }
    .tabs a.on { background: #272729; color: #ff4500; }
    .tabs a:hover { color: #d7dcdc; }
    .wrap { max-width: 760px; margin: 16px auto; padding: 0 12px; }
    .scopebar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; row-gap: 8px; margin-bottom: 10px; }
    .custom { flex-basis: 100%; }
    .scopelabel { color: #818384; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }
    .pill { color: #818384; text-decoration: none; font-size: 12px; border: 1px solid #343536; background: #1a1a1b; padding: 4px 10px; border-radius: 999px; }
    .pill.on { color: #ff4500; border-color: #ff4500; }
    .pill:hover { color: #d7dcdc; }
    .custom { display: inline-flex; gap: 6px; align-items: center; }
    .custom input[type="date"] { background: #1a1a1b; color: #d7dcdc; border: 1px solid #343536; border-radius: 6px; font-size: 12px; padding: 3px 6px; color-scheme: dark; }
    .custom button { background: #272729; color: #d7dcdc; border: 1px solid #343536; border-radius: 6px; font-size: 12px; padding: 4px 10px; cursor: pointer; }
    .custom button:hover { color: #ff4500; }
    .pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .post { display: flex; gap: 10px; background: #1a1a1b; border: 1px solid #343536; border-radius: 6px; margin-bottom: 12px; padding: 10px 12px; }
    .post:hover { border-color: #565758; }
    .vote { width: 44px; flex: none; text-align: center; font-size: 12px; color: #d7dcdc; padding-top: 6px; }
    .vote .arrow { color: #ff4500; font-size: 13px; line-height: 1; margin-bottom: 3px; }
    .vote .score { font-weight: 700; font-size: 13px; line-height: 1.3; }
    .vote .diff { font-size: 11px; line-height: 1.5; }
    .vote .diff.up { color: #4ade80; }
    .vote .diff.down { color: #f87171; }
    .vote .diff.flat { color: #343536; }
    .vote .sightings { color: #818384; font-size: 10px; margin-top: 4px; }
    .content { flex: 1; min-width: 0; }
    .meta { color: #818384; font-size: 12px; margin-bottom: 6px; }
    .meta .sub { color: #d7dcdc; text-decoration: none; font-weight: 700; }
    .meta .sub:hover { color: #ff4500; }
    .meta .sep { margin: 0 4px; }
    .title { display: inline-block; color: #d7dcdc; text-decoration: none; font-size: 17px; font-weight: 500; line-height: 1.35; margin: 2px 0 6px; }
    .title:hover { color: #ff4500; }
    .imglink { display: block; margin: 8px 0 4px; }
    .thumb { display: block; max-width: min(100%, 560px); max-height: 460px; border-radius: 6px; border: 1px solid #343536; }
    .md { white-space: pre-wrap; color: #c3cfd8; font-size: 13px; margin-top: 6px; }
    details.more { margin-top: 2px; }
    details.more summary { cursor: pointer; color: #4f8cc7; font-size: 12px; padding: 4px 0; }
    details.more .md { margin-top: 4px; }
    .foot { display: flex; gap: 16px; align-items: center; margin-top: 10px; font-size: 12px; color: #818384; }
    .foot .open { color: #ff4500; text-decoration: none; font-weight: 700; }
    .foot .open:hover { text-decoration: underline; }
    .empty { color: #818384; text-align: center; padding: 40px 0; }
    .daynav { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 12px; font-size: 13px; }
    .daynav a { color: #4f8cc7; text-decoration: none; }
    .daynav a:hover { color: #ff4500; }
    .daynav .daytitle { color: #d7dcdc; font-weight: 700; }
    .daynav .ghost { color: #343536; }
  </style>
</head>
<body>
  <header>
    <div class="headrow">
      <div class="logo">redtap <span>pool</span></div>
      <div class="count">${visible.length} posts · ${subreddits.length === 1 ? "1 sub" : subreddits.length + " subs"} · <a href="/rss.xml" style="color:#ff4500;text-decoration:none;font-weight:600">RSS</a></div>
      <nav class="tabs">${tabLinks}</nav>
    </div>
  </header>
  <div class="wrap">
    ${dayNav}
    <div class="scopebar">
      <span class="scopelabel">${scopeLabel ? escapeHtml(scopeLabel) : "posted"}</span>
      ${rangeLinks}
      <form class="custom" method="get" action="${scopeUrl()}">
        <input type="hidden" name="sort" value="${activeSort}" />
        ${pageState.subreddit ? `<input type="hidden" name="subreddit" value="${escapeHtml(pageState.subreddit)}" />` : ""}
        <input type="date" name="from" value="${from}" />
        <input type="date" name="to" value="${to}" />
        <button type="submit">apply</button>
      </form>
    </div>
    <div class="pills">${subLinks}</div>
    ${rows || '<div class="empty">nothing pooled in this scope</div>'}
  </div>
</body>
</html>`;
}

function filterPosts(posts: PostSummary[], now: number): PostSummary[] {
  const { subreddit, range, from, to } = pageState;
  let filtered = subreddit ? posts.filter((p) => p.subreddit === subreddit) : posts;

  const preset = RANGES.find((r) => r.key === range);
  const startMs = preset && preset.ms !== Number.POSITIVE_INFINITY ? now - preset.ms : null;
  const fromMs = from ? Date.parse(from + "T00:00:00.000Z") : undefined;
  const toMs = to ? Date.parse(to + "T23:59:59.999Z") : undefined;

  if (startMs === null && fromMs === undefined && toMs === undefined) return filtered;
  return filtered.filter((p) => {
    const at = p.post_at;
    if (at === null) return false;
    if (startMs !== null && at < startMs) return false;
    if (fromMs !== undefined && at < fromMs) return false;
    if (toMs !== undefined && at > toMs) return false;
    return true;
  });
}
