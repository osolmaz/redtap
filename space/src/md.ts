// Minimal safe markdown renderer for reddit selftexts.
// Strategy: escape ALL html first, then apply markdown on the escaped text
// and only emit tags we generated ourselves. Link hrefs must be http(s).

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed) || /^http:\/\//i.test(trimmed)) return trimmed;
  if (/^\/r\//i.test(trimmed)) return "https://www.reddit.com" + trimmed;
  return null;
}

const CODE_BLOCK = /^```(\w*)\n?([\s\S]*?)```$/;

function inline(text: string): string {
  let out = esc(text);
  // fenced inline code first, protected with placeholders
  const codes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // links [text](url)
  out = out.replaceAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label: string, url: string) => {
    const safe = safeUrl(url);
    return safe === null ? m : `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  // bare urls
  out = out.replaceAll(/(?<!["'>=])\b(https:\/\/[^\s<>()\[\]]+[^\s<>().,\[\]"'!?])/g, (m) => `<a href="${esc(m)}" target="_blank" rel="noreferrer">${m.length > 80 ? m.slice(0, 77) + "…" : m}</a>`);
  out = out.replaceAll(/\*\*([^*\n][^*\n]*?)\*\*/g, "<strong>$1</strong>");
  out = out.replaceAll(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  out = out.replaceAll(/~~([^~\n]+)~~/g, "<del>$1</del>");
  out = out.replaceAll(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

/** Render a reddit markdown body to safe HTML. */
export function renderMarkdown(source: string): string {
  const blocks = source.replaceAll(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim());
  const html: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (block === "") continue;
    const fence = block.match(CODE_BLOCK);
    if (fence) {
      html.push(`<pre><code>${esc(fence[2].replace(/\n$/, ""))}</code></pre>`);
      continue;
    }
    if (/^#{1,6}\s/.test(block)) {
      const level = Math.min(block.match(/^#+/)?.[0].length ?? 1, 4);
      html.push(`<h${level}>${inline(block.replace(/^#+\s*/, ""))}</h${level}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(block)) {
      html.push("<hr />");
      continue;
    }
    if (block.startsWith("&gt;") || block.startsWith(">")) {
      const quoted = block
        .split("\n")
        .map((l) => l.replace(/^&gt;\s?/, "").replace(/^>\s?/, ""))
        .join("\n");
      html.push(`<blockquote>${inline(quoted).replaceAll(/\n/g, "<br />")}</blockquote>`);
      continue;
    }
    const listLines = block.split("\n");
    if (listLines.every((l) => /^\s*[-*+]\s+/.test(l) || l.trim() === "") && listLines.some((l) => /^\s*[-*+]\s+/.test(l))) {
      html.push(`<ul>${listLines.filter((l) => l.trim() !== "").map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ""))}</li>`).join("")}</ul>`);
      continue;
    }
    if (listLines.every((l) => /^\s*\d+[.)]\s+/.test(l) || l.trim() === "") && listLines.some((l) => /^\s*\d+[.)]\s+/.test(l))) {
      html.push(`<ol>${listLines.filter((l) => l.trim() !== "").map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`);
      continue;
    }
    html.push(`<p>${inline(block).replaceAll(/\n/g, "<br />")}</p>`);
  }
  return html.join("\n");
}
