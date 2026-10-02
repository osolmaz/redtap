// The browse UI: a server-rendered table of pooled posts with momentum.
import type { PostSummary } from "./record-store.js";

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
  if (value === null) return "–";
  if (value > 0) return "+" + value;
  return String(value);
}

export function renderBrowsePage(posts: PostSummary[], filter: string | undefined, now: number): string {
  const subreddits = [...new Set(posts.map((p) => p.subreddit).filter((s): s is string => s !== null))].sort();
  const visible = filter ? posts.filter((p) => p.subreddit === filter) : posts;
  const sorted = [...visible].sort((a, b) => b.last_seen - a.last_seen);
  const rows = sorted
    .map(
      (p) => `<tr>
        <td><a href="https://www.reddit.com${escapeHtml(p.permalink)}">${escapeHtml(p.title ?? p.post_id)}</a></td>
        <td>${escapeHtml(p.subreddit ?? "")}</td>
        <td>${escapeHtml(p.author ?? "")}</td>
        <td class="num">${p.score_last ?? "–"}</td>
        <td class="num">${delta(p.score_delta)}</td>
        <td class="num">${p.comments_last ?? "–"}</td>
        <td class="num">${delta(p.comments_delta)}</td>
        <td class="num">${p.observations}</td>
        <td>${ago(p.first_seen, now)}</td>
        <td>${ago(p.last_seen, now)}</td>
      </tr>`,
    )
    .join("\n");
  const filters = ['<a href="/">all</a>'].concat(
    subreddits.map((s) => `<a href="?subreddit=${encodeURIComponent(s)}">${escapeHtml(s)}</a>`),
  );
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>redtap pool</title>
  <style>
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #15202b; color: #e7e9ea; margin: 0; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h1 span { color: #ff4500; }
    .sub { color: #8b98a5; margin-bottom: 16px; }
    .sub a { color: #8b98a5; margin-right: 10px; }
    .sub a.on { color: #ff4500; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align: left; color: #8b98a5; font-size: 12px; padding: 6px 10px; border-bottom: 1px solid #38444d; }
    td { padding: 6px 10px; border-bottom: 1px solid #253341; }
    td a { color: #e7e9ea; text-decoration: none; }
    td a:hover { color: #ff4500; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .delta-up { color: #4ade80; }
    .delta-down { color: #f87171; }
  </style>
</head>
<body>
  <h1>redtap <span>pool</span></h1>
  <div class="sub">${posts.length} posts · ${escapeHtml(String(subreddits.length))} subreddits · filter: ${filters.join("")}</div>
  <table>
    <thead>
      <tr>
        <th>Post</th><th>Subreddit</th><th>Author</th>
        <th>Score</th><th>Δscore</th><th>Comments</th><th>Δcomments</th>
        <th>Sightings</th><th>First seen</th><th>Last seen</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}
