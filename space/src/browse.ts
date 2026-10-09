// The browse UI: a Reddit-style feed of pooled posts with momentum.
// Server-rendered, no JavaScript: sort tabs (hot/new/top/rising), a time
// scope (hour/day/week/month/year/all or a custom date range), subreddit
// filter pills, vote-pill cards with bodies extended by default.

import type { PostSummary, StoredRecord } from "./record-store.js";
import { renderMarkdown } from "./md.ts";
import { engagementChart } from "./chart.ts";

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

const CARD_BODY_LIMIT = 1_000;

function bodyHtml(p: PostSummary, mode: "card" | "page" = "card"): string {
  if (!p.selftext) return "";
  const text = p.selftext;
  const limit = mode === "page" ? BODY_LIMIT : CARD_BODY_LIMIT;
  if (text.length <= limit) {
    return `<div class="md">${renderMarkdown(text)}</div>`;
  }
  // Split at a block boundary near the limit so the fold starts clean.
  let cut = text.lastIndexOf("\n\n", limit);
  if (cut < limit / 2) cut = limit;
  const head = `<div class="md">${renderMarkdown(text.slice(0, cut))}</div>`;
  if (mode === "card") {
    return `${head}<a class="more" href="${postPath(p)}">read more (${(text.length - cut).toLocaleString("en-US")} more characters) →</a>`;
  }
  return `${head}<details class="more"><summary>show remaining ${(text.length - cut).toLocaleString("en-US")} characters</summary><div class="md">${renderMarkdown(text.slice(cut))}</div></details>`;
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
  return `<a class="imglink" href="${escapeHtml(postPath(p))}"><img class="thumb" src="${escapeHtml(src)}" loading="lazy" referrerpolicy="no-referrer" alt="post image" /></a>`;
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

/** Local standalone page for a post, reddit-path style. */
export function postPath(p: { post_id: string; subreddit?: string | null }): string {
  const sub = p.subreddit ? "/r/" + p.subreddit.replace(/^r\//i, "") : "";
  return `${sub}/comments/${p.post_id.replace(/^t3_/, "")}/`;
}

function card(p: PostSummary, now: number, sort: SortKey): string {
  const body = bodyHtml(p);
  const image = imageHtml(p);
  const scoreDelta = delta(p.score_delta);
  const commentsDelta = delta(p.comments_delta);
  const local = postPath(p);
  return `<article class="post">
    <div class="vote">
      <div class="arrow">▲</div>
      <div class="score">${p.score_last ?? "–"}</div>
      <div class="diff ${deltaClass(p.score_delta)}">${scoreDelta || "&nbsp;"}</div>
      <a class="sightings" title="times seen — click for the engagement graph" href="${postPath(p)}">${p.observations}👁</a>
    </div>
    <div class="content">
      <div class="meta">
        <a class="sub" href="${pageUrl({ subreddit: p.subreddit })}">${escapeHtml(p.subreddit ?? "r/unknown")}</a>
        <span class="sep">·</span>
        <span class="author">u/${escapeHtml(p.author ?? "unknown")}</span>
        <span class="sep">·</span>
        <span class="when" title="${whenTitle(p)}">${whenLabel(p, now)}</span>
      </div>
      <a class="title" href="${local}">${escapeHtml(p.title ?? p.post_id)}</a>
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

const STYLE = `    * { box-sizing: border-box; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1416; color: #d7dcdc; margin: 0; }
    .alphanote { max-width: 960px; margin: 8px auto 0; padding: 6px 14px; border: 1px solid #343536; border-radius: 6px; color: #818384; font-size: 12px; text-align: center; }
    header { background: #1a1a1b; border-bottom: 1px solid #343536; padding: 10px 20px; position: sticky; top: 0; z-index: 2; }
    .headrow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; max-width: 760px; margin: 0 auto; }
    .logo { font-weight: 700; font-size: 17px; color: #ff4500; letter-spacing: -0.5px; white-space: nowrap; }
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
    .title { display: inline-block; color: #d7dcdc; text-decoration: none; font-size: 17px; font-weight: 500; line-height: 1.35; margin: 2px 0 6px; overflow-wrap: anywhere; }
    .title:hover { color: #ff4500; }
    .imglink { display: block; margin: 8px 0 4px; }
    .thumb { display: block; max-width: min(100%, 560px); max-height: 460px; border-radius: 6px; border: 1px solid #343536; }
    .md { color: #c3cfd8; font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; }
    details.more { margin-top: 2px; }
    details.more summary { cursor: pointer; color: #4f8cc7; font-size: 12px; padding: 4px 0; }
    a.more { display: block; color: #4f8cc7; text-decoration: none; font-size: 12px; padding: 4px 0; }
    a.more:hover { color: #ff4500; }
    details.more .md { margin-top: 4px; }
    .foot { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: #818384; }
    @media (max-width: 480px) {
      .wrap { padding: 0 8px; }
      .post { padding: 8px 10px; gap: 8px; }
      .vote { width: 38px; }
      .title { font-size: 16px; }
      .thumb { max-width: 100%; max-height: 380px; }
      .tabs a { padding: 5px 10px; }
      .custom input[type="date"] { flex: 1; min-width: 0; }
    }
    .foot .open { color: #ff4500; text-decoration: none; font-weight: 700; }
    .foot .open:hover { text-decoration: underline; }
    .empty { color: #818384; text-align: center; padding: 40px 0; }
    .chart { display: block; width: 100%; height: auto; margin-top: 10px; }
    .chart .axis { stroke: #343536; stroke-width: 1; }
    .chart .tick { fill: #818384; font-size: 10px; font-family: inherit; }
    .chart .scoreline { fill: none; stroke: #ff4500; stroke-width: 2; }
    .chart .commentline { fill: none; stroke: #4f8cc7; stroke-width: 1.5; stroke-dasharray: 4 3; }
    .chart circle { fill: #ff4500; }
    .chart .commentline + circle, .chart polyline.commentline ~ circle { fill: #4f8cc7; }
    .chart .lastval { fill: #ff4500; font-size: 11px; font-weight: 700; }
    .legend { display: flex; gap: 12px; margin-top: 2px; font-size: 11px; color: #818384; }
    .legend .key::before { content: "— "; }
    .legend .scorekey::before { color: #ff4500; }
    .legend .commentkey::before { color: #4f8cc7; }
    .daynav { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 12px; font-size: 13px; }
    .daynav a { color: #4f8cc7; text-decoration: none; }
    .daynav a:hover { color: #ff4500; }
    .daynav .daytitle { color: #d7dcdc; font-weight: 700; }
    .daynav .ghost { color: #343536; }

    .md h1, .md h2, .md h3, .md h4 { color: #d7dcdc; margin: 14px 0 6px; line-height: 1.3; }
    .md h1 { font-size: 19px; }
    .md h2 { font-size: 17px; }
    .md h3, .md h4 { font-size: 15px; }
    .md p { margin: 0 0 8px; }
    .md a { color: #4f8cc7; text-decoration: none; overflow-wrap: anywhere; }
    .md a:hover { color: #ff4500; }
    .md pre { background: #0b1416; border: 1px solid #343536; border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
    .md pre code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c3cfd8; }
    .md code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b1416; border: 1px solid #343536; border-radius: 4px; padding: 1px 5px; }
    .md pre code { border: none; padding: 0; background: none; }
    .md blockquote { border-left: 3px solid #343536; margin: 8px 0; padding: 2px 0 2px 12px; color: #818384; }
    .md ul, .md ol { margin: 8px 0; padding-left: 22px; }
    .md li { margin: 3px 0; }
    .md hr { border: none; border-top: 1px solid #343536; margin: 12px 0; }
    .postpage .title { font-size: 20px; }
    .stats { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #343536; font-size: 12px; color: #818384; }
    .stats b { color: #d7dcdc; }
    .backlink { display: inline-block; margin: 2px 0 10px; color: #4f8cc7; text-decoration: none; font-size: 13px; }
    .backlink:hover { color: #ff4500; }
    .gobtn { display: inline-block; background: #ff4500; color: #fff; text-decoration: none; font-weight: 700; font-size: 13px; padding: 8px 14px; border-radius: 999px; margin-top: 12px; }
    .gobtn:hover { background: #ff6a33; }
`;

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

  // Hacker-News-style time navigation: every browsable window (a calendar
  // day, a custom range, or the day/week/month/year scopes) gets prev/next
  // links that shift the window by its own length.
  const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const fmtShort = (d: string): string => {
    const t = new Date(d + "T00:00:00.000Z");
    return Number.isFinite(t.getTime())
      ? t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
      : d;
  };
  const DAY_MS = 86_400_000;
  let timeNav = "";
  {
    const fromMs = from ? Date.parse(from + "T00:00:00.000Z") : null;
    const toMs = to ? Date.parse(to + "T00:00:00.000Z") : null;
    let startMs: number | null = null;
    let windowMs: number | null = null;
    let title = "";
    if (fromMs !== null) {
      const end = toMs ?? fromMs;
      startMs = fromMs;
      windowMs = Math.max(end - fromMs + DAY_MS, DAY_MS);
      title =
        from === to
          ? new Date(fromMs).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
          : `${fmtShort(from)} → ${fmtShort(to || from)}`;
    } else {
      const preset = RANGES.find((r) => r.key === activeRange);
      if (preset && Number.isFinite(preset.ms) && preset.key !== "hour") {
        startMs = now - preset.ms;
        windowMs = preset.ms;
        title = "past " + preset.label;
      }
    }
    if (startMs !== null && windowMs !== null) {
      const prevFrom = fmtDay(startMs - windowMs);
      const prevTo = fmtDay(startMs - 1);
      const prev = pageUrl({ range: undefined, from: prevFrom, to: prevTo });
      const nextStart = startMs + windowMs;
      const next = nextStart < now
        ? pageUrl({ range: undefined, from: fmtDay(nextStart), to: fmtDay(Math.min(nextStart + windowMs, now) - DAY_MS) })
        : null;
      timeNav = `<div class="daynav">
        <a href="${prev}">← prev</a>
        <span class="daytitle">${escapeHtml(title)}</span>
        ${next ? `<a href="${next}">next →</a>` : `<span class="ghost">next →</span>`}
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
${STYLE}  </style>
</head>
<body>
  <header>
    <div class="headrow">
      <div class="logo">redtap <span>pool</span></div>
      <div class="count">${visible.length} posts · ${subreddits.length === 1 ? "1 sub" : subreddits.length + " subs"} · <a href="/rss.xml" style="color:#ff4500;text-decoration:none;font-weight:600">RSS</a></div>
      <nav class="tabs">${tabLinks}</nav>
    </div>
  </header>
  <div class="alphanote">alpha — under active development; things may move</div>
  <div class="wrap">
    ${timeNav}
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

export function renderPostPage(
  summary: PostSummary,
  sightings: StoredRecord[],
  now: number,
): string {
  const p = summary;
  const scoreDelta = delta(p.score_delta);
  const commentsDelta = delta(p.comments_delta);
  const redditUrl = "https://www.reddit.com" + p.permalink;
  const firstSeen = new Date(p.first_seen).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const lastSeen = new Date(p.last_seen).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const posted = p.post_at !== null ? new Date(p.post_at).toUTCString() : "unknown";
  const image = imageHtml(p);
  const stat = (label: string, value: string): string => `<span>${label} <b>${escapeHtml(value)}</b></span>`;
  const chartHtml = sightings.length > 1 ? engagementChart(sightings) : "";
  const history = sightings.length > 1
    ? `<div class="stats">` + [
        stat("first seen", firstSeen),
        stat("last seen", lastSeen),
        stat("score then", String(p.score_first ?? "?")),
        stat("score now", String(p.score_last ?? "?")),
        stat("gained", (scoreDelta && scoreDelta !== "0" ? scoreDelta : "0")),
        stat("sightings", String(p.observations)),
      ].join("") + `</div>`
    : `<div class="stats">` + [stat("posted", posted), stat("seen", p.observations + (p.observations === 1 ? " time" : " times"))].join("") + `</div>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(p.title ?? p.post_id)} — redtap pool</title>
  <link rel="icon" type="image/png" href="/static/icon48.png" />
  <style>
${STYLE}  </style>
</head>
<body>
  <header>
    <div class="headrow">
      <div class="logo">redtap <span>pool</span></div>
      <a class="backlink" href="${pageUrl({ subreddit: p.subreddit })}">← ${escapeHtml(p.subreddit ?? "pool")}</a>
    </div>
  </header>
  <div class="alphanote">alpha — under active development; things may move</div>
  <div class="wrap">
    <article class="post postpage">
      <div class="vote">
        <div class="arrow">▲</div>
        <div class="score">${p.score_last ?? "–"}</div>
        <div class="diff ${deltaClass(p.score_delta)}">${scoreDelta || "&nbsp;"}</div>
        <a class="sightings" title="times seen — click for the engagement graph" href="${postPath(p)}">${p.observations}👁</a>
      </div>
      <div class="content">
        <div class="meta">
          <a class="sub" href="${pageUrl({ subreddit: p.subreddit })}">${escapeHtml(p.subreddit ?? "r/unknown")}</a>
          <span class="sep">·</span>
          <span class="author">u/${escapeHtml(p.author ?? "unknown")}</span>
          <span class="sep">·</span>
          <span class="when" title="${whenTitle(p)}">${whenLabel(p, now)}</span>
        </div>
        <h1 class="title">${escapeHtml(p.title ?? p.post_id)}</h1>
        ${image}
        ${bodyHtml(p, "page")}
        ${chartHtml}
        ${history}
        <a class="gobtn" href="${escapeHtml(redditUrl)}" target="_blank" rel="noreferrer">open on reddit ↗</a>
        <span class="foot"><span class="comments">💬 ${p.comments_last ?? "–"}${commentsDelta ? ` <span class="diff ${deltaClass(p.comments_delta)}">(${commentsDelta})</span>` : ""}</span></span>
      </div>
    </article>
  </div>
</body>
</html>`;
}
