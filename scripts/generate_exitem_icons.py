from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path
from typing import Iterable, Tuple
import binascii

CANVAS = 32.0
ICON_DIR = Path(__file__).resolve().parents[1] / "addon" / "content" / "icons"


Color = Tuple[float, float, float]
PM = Tuple[float, float, float, float]


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else hi if x > hi else x


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(a: Color, b: Color, t: float) -> Color:
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t))


def pm(color: Color, alpha: float) -> PM:
    a = clamp(alpha)
    return (color[0] * a, color[1] * a, color[2] * a, a)


def over(dst: PM, src: PM) -> PM:
    # Premultiplied-alpha source-over compositing.
    inv = 1.0 - src[3]
    return (
        src[0] + dst[0] * inv,
        src[1] + dst[1] * inv,
        src[2] + dst[2] * inv,
        src[3] + dst[3] * inv,
    )


def distance_point_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    c1 = vx * wx + vy * wy
    c2 = vx * vx + vy * vy
    if c2 <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = clamp(c1 / c2)
    qx = ax + t * vx
    qy = ay + t * vy
    return math.hypot(px - qx, py - qy)


def sdf_round_rect(px: float, py: float, x: float, y: float, w: float, h: float, r: float) -> float:
    cx = x + w / 2.0
    cy = y + h / 2.0
    dx = abs(px - cx) - (w / 2.0 - r)
    dy = abs(py - cy) - (h / 2.0 - r)
    ox = max(dx, 0.0)
    oy = max(dy, 0.0)
    outside = math.hypot(ox, oy)
    inside = min(max(dx, dy), 0.0)
    return outside + inside - r


def rect_contains(px: float, py: float, x: float, y: float, w: float, h: float) -> bool:
    return x <= px <= x + w and y <= py <= y + h


def gaussian(px: float, py: float, cx: float, cy: float, sigma: float) -> float:
    dx = px - cx
    dy = py - cy
    return math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))


def sample_scene(px: float, py: float) -> PM:
    # Rounded square mask
    sdf = sdf_round_rect(px, py, 1.5, 1.5, 29.0, 29.0, 7.0)
    if sdf > 0:
        return (0.0, 0.0, 0.0, 0.0)

    out: PM = (0.0, 0.0, 0.0, 0.0)

    # Base gradient background (deep navy -> cyan-teal)
    t = clamp((px * 0.62 + py * 0.38) / CANVAS)
    bg = lerp_color((0.035, 0.075, 0.155), (0.035, 0.47, 0.57), t)
    # Add atmospheric glows
    glow_tl = gaussian(px, py, 9.0, 7.5, 7.5)
    glow_br = gaussian(px, py, 25.5, 24.5, 8.5)
    glow_mid = gaussian(px, py, 17.0, 16.0, 10.0)
    bg = (
        clamp(bg[0] + 0.10 * glow_tl + 0.04 * glow_mid + 0.03 * glow_br),
        clamp(bg[1] + 0.08 * glow_tl + 0.06 * glow_mid + 0.07 * glow_br),
        clamp(bg[2] + 0.13 * glow_tl + 0.08 * glow_mid + 0.03 * glow_br),
    )
    out = over(out, pm(bg, 1.0))

    # Inner border highlight for a polished icon edge
    edge_depth = -sdf
    if 0.0 <= edge_depth < 1.15:
        alpha = (1.15 - edge_depth) / 1.15 * 0.20
        out = over(out, pm((0.88, 0.96, 1.0), alpha))
    if 0.0 <= edge_depth < 2.4 and py > 15.5:
        alpha = (2.4 - edge_depth) / 2.4 * 0.10 * ((py - 15.5) / 16.5)
        out = over(out, pm((0.0, 0.0, 0.0), alpha))

    # Subtle diagonal guide line (evokes reading/annotation flow)
    dguide = distance_point_segment(px, py, 6.5, 26.0, 27.5, 5.5)
    if dguide <= 0.65:
        out = over(out, pm((0.75, 0.95, 1.0), 0.08 * (1.0 - dguide / 0.65)))

    # "E" monogram blocks (left)
    e_color = (0.97, 0.985, 1.0)
    e_glow = (0.70, 0.92, 1.0)
    e_mask = (
        rect_contains(px, py, 6.0, 7.0, 3.9, 18.0)
        or rect_contains(px, py, 6.0, 7.0, 11.4, 3.7)
        or rect_contains(px, py, 6.0, 14.0, 9.0, 3.6)
        or rect_contains(px, py, 6.0, 21.2, 11.4, 3.8)
    )
    if e_mask:
        # soft cyan glow under E then main fill
        out = over(out, pm(e_glow, 0.12))
        out = over(out, pm(e_color, 0.98))

    # "X" monogram strokes (right) with layered colors for small-size legibility
    d1 = distance_point_segment(px, py, 18.0, 7.8, 26.1, 24.1)
    d2 = distance_point_segment(px, py, 26.0, 8.0, 18.2, 24.1)
    x_core_w = 1.75
    x_glow_w = 3.0
    if d1 <= x_glow_w:
        out = over(out, pm((0.09, 0.98, 0.76), 0.16 * (1.0 - d1 / x_glow_w)))
    if d2 <= x_glow_w:
        out = over(out, pm((0.20, 0.76, 1.0), 0.16 * (1.0 - d2 / x_glow_w)))
    if d1 <= x_core_w:
        c = lerp_color((0.10, 0.96, 0.70), (0.40, 1.0, 0.88), clamp(py / CANVAS))
        out = over(out, pm(c, 0.98))
    if d2 <= x_core_w:
        c = lerp_color((0.36, 0.80, 1.0), (0.60, 0.88, 1.0), clamp(py / CANVAS))
        out = over(out, pm(c, 0.98))

    # Small center spark (AI cue) kept minimal for 16px readability
    spark = gaussian(px, py, 21.9, 15.9, 0.75)
    if spark > 0.02:
        out = over(out, pm((1.0, 1.0, 1.0), 0.28 * spark))

    return out


def render_icon(size: int, supersample: int = 8) -> bytes:
    rows = bytearray()
    scale = CANVAS / size
    n = supersample * supersample
    for y in range(size):
        rows.append(0)  # PNG filter type 0
        for x in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(supersample):
                for sx in range(supersample):
                    px = (x + (sx + 0.5) / supersample) * scale
                    py = (y + (sy + 0.5) / supersample) * scale
                    r, g, b, a = sample_scene(px, py)
                    acc_r += r
                    acc_g += g
                    acc_b += b
                    acc_a += a
            pr = acc_r / n
            pg = acc_g / n
            pb = acc_b / n
            pa = acc_a / n
            if pa > 1e-6:
                sr = clamp(pr / pa)
                sg = clamp(pg / pa)
                sb = clamp(pb / pa)
            else:
                sr = sg = sb = 0.0
            rows.extend(
                (
                    int(round(sr * 255)),
                    int(round(sg * 255)),
                    int(round(sb * 255)),
                    int(round(clamp(pa) * 255)),
                )
            )
    return bytes(rows)


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, width: int, height: int, raw_scanlines: bytes) -> None:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw_scanlines, level=9)
    png = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size, name in [(32, "favicon.png"), (16, "favicon@0.5x.png")]:
        raw = render_icon(size=size, supersample=8)
        write_png(ICON_DIR / name, size, size, raw)
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
