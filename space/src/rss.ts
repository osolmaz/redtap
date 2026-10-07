import type { PostSummary } from "./record-store.ts";

const RSS_LIMIT = 100;
const RSS_BODY_CHARS = 1200;

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

function stripHtml(text: string): string {
  return text
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&[a-z]+;/gi, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** RSS 2.0 feed of the pool's daily hot ranking: the last 24h of posts
 *  ranked by score gained since first sighting. */
export function renderRss(posts: PostSummary[], origin: string): string {
  const cutoff = Date.now() - 24 * 3600_000;
  const newest = posts
    .filter((p) => (p.post_at ?? 0) >= cutoff)
    .sort((a, b) => (b.score_delta ?? b.score_last ?? 0) - (a.score_delta ?? a.score_last ?? 0))
    .slice(0, RSS_LIMIT);
  const items = newest
    .map((p) => {
      const link = `${origin}/r/${(p.subreddit ?? "").replace(/^r\//i, "")}/comments/${p.post_id.replace(/^t3_/, "")}/`;
      const title = xmlEscape(p.title ?? p.permalink);
      const body = p.selftext ? stripHtml(p.selftext).slice(0, RSS_BODY_CHARS) : "";
      const meta = [p.author ? "by u/" + p.author : "", p.score_last !== null ? p.score_last + " points" : "", p.comments_last !== null ? p.comments_last + " comments" : ""]
        .filter(Boolean)
        .join(" | ");
      const description = xmlEscape((meta ? meta + "\n" : "") + body);
      return `    <item>
      <title>${title}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">redtap:${xmlEscape(p.post_id)}</guid>
      <pubDate>${rfc822(p.post_at ?? 0)}</pubDate>
      <description>${description}</description>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>redtap pool — r/LocalLLaMA (daily hot)</title>
    <link>${xmlEscape(origin)}/</link>
    <description>Today's hottest posts in the redtap pool, ranked by score gained</description>
    <lastBuildDate>${rfc822(Date.now())}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
