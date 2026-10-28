"""Draw Cortex's app icon (a rounded square with three linked notes) and save it as a multi-size .ico.

Standard library only, so the icon can be rebuilt anywhere: python packaging/make_icon.py
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

BG = (91, 76, 219)        # Cortex accent purple
FG = (255, 255, 255)
NODES = [(0.32, 0.36), (0.68, 0.30), (0.52, 0.70)]


def pixel(x: float, y: float) -> tuple[int, int, int, int]:
    """Colour at (x, y) in 0..1 space, with soft edges for anti-aliasing at small sizes."""
    r, inset = 0.22, 0.04                       # corner radius, outer margin
    dx = max(abs(x - 0.5) - (0.5 - inset - r), 0)
    dy = max(abs(y - 0.5) - (0.5 - inset - r), 0)
    edge = r - math.hypot(dx, dy)
    if edge <= 0:
        return (0, 0, 0, 0)
    alpha = min(1.0, edge * 60)
    ink = 0.0
    for i, (ax, ay) in enumerate(NODES):         # the three links between notes
        bx, by = NODES[(i + 1) % len(NODES)]
        t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        d = math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)))
        ink = max(ink, min(1.0, (0.035 - d) * 60 + 0.5))
    for ax, ay in NODES:                          # the notes themselves
        ink = max(ink, min(1.0, (0.10 - math.hypot(x - ax, y - ay)) * 60 + 0.5))
    ink = max(0.0, ink)
    c = tuple(round(BG[k] * (1 - ink) + FG[k] * ink) for k in range(3))
    return (*c, round(alpha * 255))


def png(size: int) -> bytes:
    rows = b"".join(b"\0" + b"".join(bytes(pixel((i + 0.5) / size, (j + 0.5) / size)) for i in range(size))
                    for j in range(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def ico(sizes: list[int]) -> bytes:
    images = [png(s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for s, data in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + entries + b"".join(images)


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("cortex.ico"))
    out.write_bytes(ico([16, 24, 32, 48, 64, 128, 256]))
    print(out)
