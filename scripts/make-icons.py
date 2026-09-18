#!/usr/bin/env python3
"""把 icon-square.svg / icon-maskable.svg 的几何栅格化成 PNG。

iOS 的「添加到主屏幕」不认 SVG 图标，必须是 PNG（apple-touch-icon 推荐 180×180），
所以这里用纯标准库手绘同一套几何：圆角矩形按 4×4 超采样算覆盖率做抗锯齿。
"""
import struct
import zlib

PURPLE = (0x7C, 0x3A, 0xED)
WHITE = (255, 255, 255)

# 与 icon-square.svg 一致（512 坐标系）
SQUARE_BARS = [
    (132, 140, 44, 232, 14, 1.0),
    (196, 180, 132, 44, 14, 0.95),
    (196, 252, 184, 44, 14, 0.8),
    (196, 324, 100, 44, 14, 0.62),
]
# 与 icon-maskable.svg 一致：主体收在中心 80% 安全区
MASK_BARS = [
    (164, 176, 38, 164, 12, 1.0),
    (220, 208, 106, 38, 12, 0.95),
    (220, 268, 146, 38, 12, 0.8),
]

SS = 4          # 每轴超采样数
BASE = 512.0    # 几何坐标系边长


def inside_rrect(x, y, x0, y0, w, h, r):
    if x < x0 or x > x0 + w or y < y0 or y > y0 + h:
        return False
    cx = None
    if x < x0 + r:
        cx = x0 + r
    elif x > x0 + w - r:
        cx = x0 + w - r
    cy = None
    if y < y0 + r:
        cy = y0 + r
    elif y > y0 + h - r:
        cy = y0 + h - r
    if cx is not None and cy is not None:
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def render(size, bars):
    k = size / BASE
    px = bytearray(size * size * 3)
    for i in range(size * size):                     # 底色：满幅纯色，不需要采样
        px[i * 3] = PURPLE[0]
        px[i * 3 + 1] = PURPLE[1]
        px[i * 3 + 2] = PURPLE[2]

    step = 1.0 / (SS + 1)                            # 子采样点位置
    offsets = [step * (j + 1) - 0.5 for j in range(SS)]

    for (bx, by, bw, bh, br, op) in bars:
        x0, y0 = bx * k, by * k
        x1, y1 = (bx + bw) * k, (by + bh) * k
        r = br * k
        px0, py0 = max(0, int(x0) - 1), max(0, int(y0) - 1)
        px1, py1 = min(size - 1, int(x1) + 1), min(size - 1, int(y1) + 1)
        for py in range(py0, py1 + 1):
            cy = py + 0.5
            for pxi in range(px0, px1 + 1):
                cx = pxi + 0.5
                hit = 0
                for oy in offsets:
                    yy = cy + oy
                    for ox in offsets:
                        if inside_rrect(cx + ox, yy, x0, y0, x1 - x0, y1 - y0, r):
                            hit += 1
                if not hit:
                    continue
                a = (hit / (SS * SS)) * op
                i = (py * size + pxi) * 3
                px[i] = int(px[i] * (1 - a) + WHITE[0] * a + 0.5)
                px[i + 1] = int(px[i + 1] * (1 - a) + WHITE[1] * a + 0.5)
                px[i + 2] = int(px[i + 2] * (1 - a) + WHITE[2] * a + 0.5)
    return bytes(px)


def write_png(path, size, rgb):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = b''.join(b'\x00' + rgb[y * size * 3:(y + 1) * size * 3] for y in range(size))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)   # 8bit truecolor，不透明
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    print('wrote', path, size, 'x', size)


if __name__ == '__main__':
    import os
    import sys
    # 默认输出到站点根目录（脚本在 scripts/ 下），可用第一个参数覆盖
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..')
    out = os.path.abspath(out)
    jobs = [
        ('apple-touch-icon.png', 180, SQUARE_BARS),
        ('icon-192.png', 192, SQUARE_BARS),
        ('icon-512.png', 512, SQUARE_BARS),
        ('icon-maskable-512.png', 512, MASK_BARS),
    ]
    for name, size, bars in jobs:
        write_png(os.path.join(out, name), size, render(size, bars))
