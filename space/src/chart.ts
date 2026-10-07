// Server-rendered SVG chart of a post's engagement over time:
// score and comment count across pool sightings. No JavaScript.

import type { StoredRecord } from "./record-store.ts";

const W = 640;
const H = 150;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 22;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function engagementChart(sightings: StoredRecord[]): string {
  const points = sightings
    .filter((s) => s.metrics?.score !== null || s.metrics?.comments !== null)
    .map((s) => ({ t: s.captured_at, score: s.metrics?.score ?? null, comments: s.metrics?.comments ?? null }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) return "";

  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 60_000);
  const x = (t: number): number => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);

  const maxScore = Math.max(...points.map((p) => p.score ?? 0), 1);
  const maxComments = Math.max(...points.map((p) => p.comments ?? 0), 1);
  const yS = (v: number): number => H - PAD_B - (v / maxScore) * (H - PAD_T - PAD_B);
  const yC = (v: number): number => H - PAD_B - (v / maxComments) * (H - PAD_T - PAD_B);

  const line = (key: "score" | "comments", y: (v: number) => number): { pts: string; dots: string } => {
    const vals = points.filter((p) => p[key] !== null);
    if (vals.length === 0) return { pts: "", dots: "" };
    return {
      pts: vals.map((p, i) => `${i === 0 ? "" : " "}${x(p.t).toFixed(1)},${y(p[key] ?? 0).toFixed(1)}`).join(" "),
      dots: vals.map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p[key] ?? 0).toFixed(1)}" r="2.5" />`).join(""),
    };
  };

  const score = line("score", yS);
  const comments = line("comments", yC);
  const last = points[points.length - 1];

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="engagement over time">
    <line class="axis" x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" />
    <line class="axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" />
    <text class="tick" x="${PAD_L - 6}" y="${yS(maxScore) + 4}" text-anchor="end">${maxScore}</text>
    <text class="tick" x="${PAD_L - 6}" y="${H - PAD_B + 4}" text-anchor="end">0</text>
    <polyline class="scoreline" points="${score.pts}" />${score.dots}
    ${comments.pts ? `<polyline class="commentline" points="${comments.pts}" />${comments.dots}` : ""}
    <text class="lastval" x="${Math.min(x(last.t) + 6, W - 60).toFixed(1)}" y="${(yS(last.score ?? 0) - 6).toFixed(1)}">${last.score ?? 0}</text>
    <text class="tick" x="${PAD_L}" y="${H - 6}">${esc(stamp(t0))}</text>
    <text class="tick" x="${W - PAD_R}" y="${H - 6}" text-anchor="end">${esc(stamp(t1))} UTC</text>
  </svg>
  <div class="legend"><span class="key scorekey">score</span>${comments.pts ? `<span class="key commentkey">comments</span>` : ""}<span class="key">${points.length} sightings</span></div>`;
}
