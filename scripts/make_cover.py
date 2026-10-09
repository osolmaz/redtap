"""Draw assets/cover.svg, the README cover, with every letter as an outline.

    uv run --with fonttools --with uharfbuzz --with pillow python scripts/make_cover.py FONT_DIR

FONT_DIR holds YodelGrotesk-Bold.otf and YodelGrotesk-Regular.otf from
https://github.com/osolmaz/yodel-grotesk (assets/fonts/yodel-grotesk). Each string is
shaped with HarfBuzz, so kerning and ligatures survive, and each glyph is drawn at the
position HarfBuzz returns. The SVG has no text elements and needs no font.

The picture: a browser scrolled through r/LocalLLaMA, with redtap's capture corners
around the post in view. Copies of posts tumble out of the window and settle into one
neat column, the redtap feed. Browse in, captured feed out.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

WIDTH, HEIGHT = 960, 320
BACKGROUND = "#F5F0E6"
TEXT = "#111111"
SECONDARY = "#4A4A4A"
CARD = "#FFFFFF"
CARD_BORDER = "#D9D3C7"
LABEL = "#6E6A62"
BAR = "#EBE7DE"
PANEL = "#F0EDE6"  # Reddit's pills and the post image, on the white page
ACCENT = "#FF4500"  # redtap's product accent: its icon, the upvote mark, the capture corners
GAIN = "#1A7F37"  # the feed's score gain since capture, green as in the product

NAME = "redtap"
TAGLINE = ["A passive Reddit scraper that captures", "the posts you browse and serves a feed."]


@dataclass
class Font:
    face: TTFont
    hb_font: hb.Font
    upem: int

    @classmethod
    def load(cls, path: Path) -> Font:
        data = path.read_bytes()
        face = hb.Face(data)
        return cls(TTFont(path), hb.Font(face), face.upem)


def shaped(font: Font, text: str, size: float, tracking: float = 0.0) -> list[tuple[str, float]]:
    """Glyph names and x positions in pixels, with HarfBuzz's kerning, then tracking and collision fixes."""
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font.hb_font, buf, {"kern": True, "liga": True})
    names = font.face.getGlyphOrder()
    scale = size / font.upem
    out, x = [], 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions, strict=True):
        out.append((names[info.codepoint], x + pos.x_offset * scale))
        x += pos.x_advance * scale + tracking
    return separate(font, out, size)


RASTER = 8  # outline samples per pixel when measuring the gap between two glyphs


def bounds(font: Font, glyph: str, size: float) -> tuple[float, float] | None:
    pen = BoundsPen(font.face.getGlyphSet())
    font.face.getGlyphSet()[glyph].draw(pen)
    if pen.bounds is None:
        return None
    scale = size / font.upem
    return pen.bounds[0] * scale, pen.bounds[2] * scale


def row_extents(font: Font, glyph: str, size: float) -> dict[int, tuple[float, float]]:
    """For each sampled row of the glyph's filled outline, its leftmost and rightmost x in pixels."""
    glyph_set = font.face.getGlyphSet()
    scale = size / font.upem * RASTER
    pen = RecordingPen()
    glyph_set[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, 0, 0)))
    contours = polygons(pen.value)
    if not contours:
        return {}
    xs = [x for c in contours for x, _ in c]
    ys = [y for c in contours for _, y in c]
    left, top = math.floor(min(xs)), math.floor(min(ys))
    img = Image.new("1", (math.ceil(max(xs)) - left + 2, math.ceil(max(ys)) - top + 2), 0)
    draw = ImageDraw.Draw(img)
    for contour in contours:
        draw.polygon([(x - left, y - top) for x, y in contour], fill=1)
    out: dict[int, tuple[float, float]] = {}
    for row in range(img.height):
        filled = [x for x in range(img.width) if img.getpixel((x, row))]
        if filled:
            out[row + top] = ((filled[0] + left) / RASTER, (filled[-1] + 1 + left) / RASTER)
    return out


def polygons(segments: list[tuple[str, tuple[tuple[float, float], ...]]]) -> list[list[tuple[float, float]]]:
    """A recorded outline as polygons, with each curve sampled at 8 points."""
    contours: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    for op, pts in segments:
        if op == "moveTo":
            cur = [pts[0]]
        elif op == "lineTo":
            cur.append(pts[0])
        elif op in ("qCurveTo", "curveTo"):
            cur.extend(bezier([cur[-1], *pts], step / 8) for step in range(1, 9))
        elif op in ("closePath", "endPath"):
            contours.append(cur)
            cur = []
    return [c for c in contours if len(c) > 2]


def bezier(points: list[tuple[float, float]], t: float) -> tuple[float, float]:
    while len(points) > 1:
        points = [((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]) for a, b in itertools.pairwise(points)]
    return points[0]


def separate(font: Font, glyphs: list[tuple[str, float]], size: float) -> list[tuple[str, float]]:
    """Push a glyph and everything after it right until its outline clears its neighbour's by 1% of the size."""
    out = list(glyphs)
    for i in range(1, len(out)):
        prev, cur = row_extents(font, out[i - 1][0], size), row_extents(font, out[i][0], size)
        shared = prev.keys() & cur.keys()
        if not shared:
            continue
        gap = min((out[i][1] + cur[r][0]) - (out[i - 1][1] + prev[r][1]) for r in shared)
        if gap < 0.01 * size:
            shift = 0.01 * size - gap
            out[i:] = [(g, x + shift) for g, x in out[i:]]
    return out


def width(font: Font, glyphs: list[tuple[str, float]], size: float) -> float:
    last, x = glyphs[-1]
    end = bounds(font, last, size)
    return x + (end[1] if end else 0)


def path(font: Font, text: str, x: float, y: float, size: float, fill: str, tracking: float = 0.0) -> str:
    """One <path> for a string with its baseline at (x, y)."""
    glyph_set = font.face.getGlyphSet()
    scale = size / font.upem
    pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    for glyph, gx in shaped(font, text, size, tracking):
        glyph_set[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, x + gx, y)))
    return f'<path fill="{fill}" d="{pen.getCommands()}"/>'


def text_width(font: Font, text: str, size: float) -> float:
    return width(font, shaped(font, text, size), size)


BUTTONS_END = 12 + 2 * 13 + 3.2  # right edge of the third window button, measured from the window's left


def window(regular: Font, x: float, y: float, w: float, h: float, title: str, inner: str) -> str:
    """A light macOS window: white body, gray title bar, buttons and a centered title, inner clipped to the body."""
    bar, r = 24.0, 8.0
    tw = text_width(regular, title, 10)
    assert x + w / 2 - tw / 2 >= x + BUTTONS_END + 8, f"window title runs into the buttons: {title}"
    body = f"M{x} {y + bar}H{x + w}V{y + h - r}a{r} {r} 0 0 1 -{r} {r}H{x + r}a{r} {r} 0 0 1 -{r} -{r}Z"
    parts = [
        f'<clipPath id="body"><path d="{body}"/></clipPath>',
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{CARD}"/>',
        f'<rect x="{x}" y="{y}" width="{w}" height="{bar}" rx="{r}" fill="{BAR}"/>',
        f'<rect x="{x}" y="{y + bar - r}" width="{w}" height="{r}" fill="{BAR}"/>',
    ]
    for i, color in enumerate(("#FF5F57", "#FEBC2E", "#28C840")):
        parts.append(f'<circle cx="{x + 12 + i * 13:.1f}" cy="{y + bar / 2:.1f}" r="3.2" fill="{color}"/>')
    parts.append(path(regular, title, x + w / 2 - tw / 2, y + bar / 2 + 3.5, 10, LABEL))
    parts.append(f'<g clip-path="url(#body)">{inner}</g>')
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="none" stroke="{CARD_BORDER}"/>')
    return "".join(parts)


def pill(regular: Font, x: float, y: float, label: str, vote: bool = False) -> tuple[str, float]:
    """A Reddit action pill, 16 tall: a word, or the score between outlined up and down arrows."""
    pad = 18 if vote else 8
    w = pad + text_width(regular, label, 9) + pad
    parts = [
        f'<rect x="{x}" y="{y}" width="{w:.1f}" height="16" rx="8" fill="{PANEL}"/>',
        path(regular, label, x + pad, y + 11.2, 9, SECONDARY),
    ]
    if vote:
        outline = f'fill="none" stroke="{LABEL}" stroke-width="0.9" stroke-linejoin="round"'
        parts.append(f'<path d="M{x + 10:.1f} {y + 4}l3.5 4.2h-2v3.8h-3v-3.8h-2z" {outline}/>')
        parts.append(f'<path d="M{x + w - 10:.1f} {y + 12}l3.5 -4.2h-2v-3.8h-3v3.8h-2z" {outline}/>')
    return "".join(parts), w


def corners(x0: float, y0: float, x1: float, y1: float, arm: float = 10) -> str:
    """redtap's capture corners, the shape of its icon's mark, at the four corners of a box."""
    d = (
        f"M{x0} {y0 + arm}V{y0}H{x0 + arm}M{x1 - arm} {y0}H{x1}V{y0 + arm}"
        f"M{x1} {y1 - arm}V{y1}H{x1 - arm}M{x0 + arm} {y1}H{x0}V{y1 - arm}"
    )
    return f'<path d="{d}" fill="none" stroke="{ACCENT}" stroke-width="2"/>'


def upvote(x: float, y: float, w: float = 9) -> str:
    """The feed's filled upvote triangle, its base centered at x on baseline y."""
    return (
        f'<path d="M{x - w / 2:.1f} {y:.1f}l{w / 2:.2f} -{w * 0.72:.2f}l{w / 2:.2f} {w * 0.72:.2f}z" fill="{ACCENT}"/>'
    )


FEED_CARD_H = 72


def feed_card(
    bold: Font, regular: Font, x: float, y: float, w: float, score: str, gain: str, meta: str, lines: list[str]
) -> str:
    """One post in the redtap feed: score rail on the left, then source, age and the title."""
    rail = x + 19
    parts = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{FEED_CARD_H}" rx="6" fill="{CARD}" stroke="{CARD_BORDER}"/>',
        upvote(rail, y + 18),
        path(bold, score, rail - text_width(bold, score, 10) / 2, y + 32, 10, TEXT),
        path(regular, gain, rail - text_width(regular, gain, 8.5) / 2, y + 44, 8.5, GAIN),
        path(regular, meta, x + 36, y + 18, 9, LABEL),
    ]
    for i, line in enumerate(lines):
        assert 36 + text_width(regular, line, 10) <= w - 12, f"feed title line too wide: {line}"
        parts.append(path(regular, line, x + 36, y + 33 + i * 13, 10, TEXT))
    return "".join(parts)


def mini_card(cx: float, cy: float, angle: float) -> str:
    """A post in flight from the page to the feed: a small card with the upvote mark and two title bars."""
    w, h = 28, 19
    return (
        f'<g transform="translate({cx:.1f} {cy:.1f}) rotate({angle}) translate({-w / 2} {-h / 2})">'
        f'<rect width="{w}" height="{h}" rx="3" fill="{CARD}" stroke="{CARD_BORDER}"/>'
        f"{upvote(7, 10, 6)}"
        f'<rect x="13" y="6" width="10" height="2.2" rx="1.1" fill="{CARD_BORDER}"/>'
        f'<rect x="13" y="11" width="7" height="2.2" rx="1.1" fill="{CARD_BORDER}"/>'
        "</g>"
    )


def build(font_dir: Path) -> str:
    bold = Font.load(font_dir / "YodelGrotesk-Bold.otf")
    regular = Font.load(font_dir / "YodelGrotesk-Regular.otf")

    top = 56  # the browser window is the tallest element; the same margin sits above and below it
    page_w, page_h = 184, HEIGHT - 2 * top
    feed_w, gap = 180, 96
    feed_x = WIDTH - 64 - feed_w - 0.5  # the cards' border is centered on their edge; keep all of it inside
    page_x = feed_x - gap - page_w

    # keep a clear 24px channel between the text block and the picture
    for line in TAGLINE:
        assert 64 + text_width(regular, line, 19) <= page_x - 24, f"tagline too wide: {line}"
    assert 64 + width(bold, shaped(bold, NAME, 64, tracking=-5), 64) <= page_x - 24, "name too wide"

    # the Reddit page: the subreddit, the post in view inside redtap's capture corners, the next post scrolling in
    ix, iw = page_x + 12, page_w - 24
    body = top + 24
    post = body + 30  # top of the post in view
    votes, vw = pill(regular, ix, post + 94, "615", vote=True)
    share, _ = pill(regular, ix + vw + 6, post + 94, "Share")
    pane = iw / 2 - 9  # the post's image: two screenshots side by side
    page = "".join(
        [
            path(bold, "r/LocalLLaMA", ix, body + 18, 10.5, TEXT),
            path(regular, "u/Mr_BETADINE · 10 hr. ago", ix, post + 10, 9, LABEL),
            path(regular, "chatgpt's new intelligent ui was", ix, post + 25, 10, TEXT),
            path(regular, "reverse engineered in less than…", ix, post + 38, 10, TEXT),
            f'<rect x="{ix}" y="{post + 46}" width="{iw}" height="40" rx="4" fill="{PANEL}"/>',
            f'<rect x="{ix + 6}" y="{post + 51}" width="{pane}" height="30" rx="2" fill="{CARD}"/>',
            f'<rect x="{ix + iw - 6 - pane}" y="{post + 51}" width="{pane}" height="30" rx="2" fill="{CARD}"/>',
            votes,
            share,
            path(regular, "u/Nunki08 · 18 hr. ago", ix, post + 128, 9, LABEL),
            path(regular, "Last week some of South Korea's", ix, post + 143, 10, TEXT),
            path(regular, "biggest banks were hit by a cyber…", ix, post + 156, 10, TEXT),
        ]
    )
    capture = corners(ix - 5, post - 5, ix + iw + 5, post + 115)

    # the feed: one neat column of captured posts, as redtap serves them
    column_h = 9 + 10 + 2 * FEED_CARD_H + 8
    head = HEIGHT / 2 - column_h / 2 + 9  # baseline of the column header
    first = head + 10
    second = first + FEED_CARD_H + 8
    count = "72 posts · 2 subs"
    feed = "".join(
        [
            path(bold, "redtap", feed_x, head, 12, ACCENT),
            path(regular, count, feed_x + feed_w - text_width(regular, count, 9), head, 9, LABEL),
            feed_card(
                bold,
                regular,
                feed_x,
                first,
                feed_w,
                "798",
                "+621",
                "r/LocalLLaMA · 18h ago",
                ["Last week some of South", "Korea's biggest banks were", "hit by a cyberattack. We…"],
            ),
            feed_card(
                bold,
                regular,
                feed_x,
                second,
                feed_w,
                "615",
                "+429",
                "r/LocalLLaMA · 10h ago",
                ["chatgpt's new intelligent ui", "was reverse engineered in", "less than 24 hours, and…"],
            ),
        ]
    )

    # posts in flight, tumbling out of the page and settling as they reach the column
    x0, y0 = page_x + page_w, post + 55
    x1, y1 = feed_x, second + FEED_CARD_H / 2
    flight = "".join(
        mini_card(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, angle) for t, angle in ((0.08, -18), (0.44, -9), (0.8, 0))
    )

    label = " ".join(TAGLINE)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'role="img" aria-label="redtap: {label}">',
        f"<title>redtap: {label}</title>",
        f'<rect width="{WIDTH}" height="{HEIGHT}" rx="12" fill="{BACKGROUND}"/>',
        path(bold, NAME, 64, 142, 64, TEXT, tracking=-5),
        path(regular, TAGLINE[0], 64, 196, 19, SECONDARY),
        path(regular, TAGLINE[1], 64, 222, 19, SECONDARY),
        window(regular, page_x, top, page_w, page_h, "reddit.com", page + capture),
        flight,
        feed,
        "</svg>",
    ]
    return "".join(parts) + "\n"


def main() -> int:
    font_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/fonts/yodel-grotesk")
    out = Path(__file__).resolve().parent.parent / "assets" / "cover.svg"
    out.parent.mkdir(exist_ok=True)
    svg = build(font_dir)
    assert "<text" not in svg and "font-family" not in svg, "delivered cover must ship no font references"
    out.write_text(svg, encoding="utf-8")
    print(out)
    for face in ("YodelGrotesk-Bold.otf", "YodelGrotesk-Regular.otf"):
        data = (font_dir / face).read_bytes()
        print(f"{face} sha256={hashlib.sha256(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
