"""
Writes the PNG launcher icons the Android app needs.

Anything from Android 8 up uses the adaptive icon in res/mipmap-anydpi-v26
(the vector drop on a gradient). Older phones cannot read that, so they get
these plain bitmaps instead.

    python dev/make-android-icons.py
"""

import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
OUT = os.path.join(PROJECT, "phone-app", "android", "res")

BG_TOP = (2, 117, 216)
BG_BOTTOM = (1, 74, 145)
DROP = (255, 255, 255)
SS = 3

# mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi
DENSITIES = [
    ("mdpi", 48),
    ("hdpi", 72),
    ("xhdpi", 96),
    ("xxhdpi", 144),
    ("xxxhdpi", 192),
]


def rounded_alpha(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    d = math.hypot(x - cx, y - cy)
    return 1.0 if d <= radius else 0.0


def droplet(x, y, cx, cy, r, d_ratio=1.42):
    dy = y - cy
    if dy >= 0:
        return (x - cx) ** 2 + dy ** 2 <= r * r

    d = d_ratio * r
    apex_y = -d
    if dy <= apex_y:
        return False

    theta = math.acos(r / d)
    ty = -r * math.cos(theta)
    tx = r * math.sin(theta)

    if dy <= ty:
        half = tx * (dy - apex_y) / (ty - apex_y)
        return abs(x - cx) <= half

    return (x - cx) ** 2 + dy ** 2 <= r * r


def render(size, inset_ratio=1.0, radius_ratio=0.22):
    cx = cy = size / 2.0
    side = size * inset_ratio
    origin = (size - side) / 2.0
    radius = side * radius_ratio

    r = side * 0.255
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

            t = y / float(size - 1)
            bg = tuple(int(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t)) for i in range(3))
            col = tuple(int(round(bg[i] * (1 - drop_a) + DROP[i] * drop_a)) for i in range(3))

            alpha = bg_a
            if drop_a > 0:
                alpha = max(bg_a, bg_a * (1 - drop_a) + drop_a)

            row += bytes((col[0], col[1], col[2], int(round(alpha * 255))))
        rows.append(row)

    return b"".join(b"\x00" + bytes(r) for r in rows)


def png(width, height, raw):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    for name, size in DENSITIES:
        folder = os.path.join(OUT, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "ic_launcher.png")
        with open(path, "wb") as fh:
            fh.write(png(size, size, render(size)))
        print("wrote %-58s %dpx  %5d bytes" % (
            os.path.relpath(path, PROJECT), size, os.path.getsize(path)))


if __name__ == "__main__":
    main()
