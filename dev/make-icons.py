"""
Draws the app icons with no image library - just zlib + struct.

A white water droplet on a blue rounded square. Run it again if you want to
change the colours:

    python dev/make-icons.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")

BG_TOP = (2, 117, 216)      # --primary
BG_BOTTOM = (1, 74, 145)    # darker for a soft gradient
DROP = (255, 255, 255)
SS = 3                      # supersampling, 3x3 per pixel


def rounded_alpha(x, y, size, radius):
    """1 inside the rounded square, 0 outside, soft near the corners."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    d = math.hypot(x - cx, y - cy)
    if d <= radius:
        return 1.0
    return 0.0


def droplet(x, y, cx, cy, r, d_ratio=1.42):
    """
    Circle at the bottom, and above its waist two straight lines that run
    tangent to that circle and meet at a point. That is what makes it read
    as a water drop instead of a cone.
    """
    dy = y - cy
    if dy >= 0:
        return (x - cx) ** 2 + dy ** 2 <= r * r

    d = d_ratio * r                 # apex distance from the circle centre
    apex_y = -d
    if dy <= apex_y:
        return False

    theta = math.acos(r / d)
    ty = -r * math.cos(theta)       # height of the tangent points
    tx = r * math.sin(theta)        # half width at the tangent points

    if dy <= ty:
        half = tx * (dy - apex_y) / (ty - apex_y)
        return abs(x - cx) <= half

    return (x - cx) ** 2 + dy ** 2 <= r * r


def render(size, inset_ratio, radius_ratio):
    """
    inset_ratio: how much of the canvas the background square uses.
                 1.0 for the normal icon, ~0.72 so Android can crop freely.
    """
    px = bytearray()
    cx = cy = size / 2.0

    side = size * inset_ratio
    origin = (size - side) / 2.0
    radius = side * radius_ratio

    r = side * 0.255
    # the drop spans cy - 1.42r .. cy + r; nudge it down so it sits centred
    drop_cy = cy + r * 0.21

    step = 1.0 / SS
    total = SS * SS

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            bg_a = 0.0
            drop_a = 0.0

            for sy in range(SS):
                for sx in range(SS):
                    pxs = x + (sx + 0.5) * step
                    pys = y + (sy + 0.5) * step
                    bg_a += rounded_alpha(pxs - origin, pys - origin, side, radius)
                    if droplet(pxs, pys, cx, drop_cy, r):
                        drop_a += 1.0
            bg_a /= total
            drop_a /= total

            if bg_a <= 0.001 and drop_a <= 0.001:
                row += b"\x00\x00\x00\x00"
                continue

            # vertical gradient
            t = y / float(size - 1)
            bg = tuple(
                int(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t))
                for i in range(3)
            )

            # composite the droplet over the background
            col = tuple(
                int(round(bg[i] * (1 - drop_a) + DROP[i] * drop_a))
                for i in range(3)
            )

            alpha = bg_a
            if drop_a > 0:
                alpha = max(bg_a, bg_a * (1 - drop_a) + drop_a)

            row += bytes((col[0], col[1], col[2], int(round(alpha * 255))))
        rows.append(row)

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    return raw


def png(width, height, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", head)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def write(name, size, inset_ratio, radius_ratio):
    path = os.path.join(OUT, name)
    with open(path, "wb") as fh:
        fh.write(png(size, size, render(size, inset_ratio, radius_ratio)))
    print("wrote %-22s %4dx%-4d %6d bytes" % (name, size, size, os.path.getsize(path)))


def main():
    os.makedirs(OUT, exist_ok=True)
    write("icon-192.png", 192, 1.0, 0.22)
    write("icon-512.png", 512, 1.0, 0.22)
    write("maskable-512.png", 512, 0.70, 0.30)
    write("apple-touch-icon.png", 180, 1.0, 0.22)
    write("favicon-64.png", 64, 1.0, 0.20)


if __name__ == "__main__":
    main()
