#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 NEXUS 应用图标（原创几何图形，不含第三方素材）。"""
from pathlib import Path

from PIL import Image, ImageDraw

BASE = Path(__file__).resolve().parent.parent
OUT_DIR = BASE / "build"
S = 512


def draw_master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 底板：近黑圆角方，带一圈很淡的描边
    r = int(S * 0.22)
    d.rounded_rectangle([S * 0.02, S * 0.02, S * 0.98, S * 0.98], radius=r,
                        fill=(7, 10, 15, 255), outline=(38, 46, 58, 255), width=max(2, S // 160))

    cx = cy = S / 2
    silver = (210, 220, 229, 255)
    dim = (120, 132, 146, 255)

    # 外环：两道细圈
    for rad, w, col in ((S * 0.335, max(2, S // 150), silver),
                        (S * 0.262, max(1, S // 260), dim)):
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=col, width=int(w))

    # 环上刻度（每 15° 一根，长短交替）
    import math
    for i in range(24):
        a = i * math.pi / 12
        r0 = S * 0.345
        r1 = r0 + (S * 0.030 if i % 3 == 0 else S * 0.016)
        d.line([cx + math.cos(a) * r0, cy + math.sin(a) * r0,
                cx + math.cos(a) * r1, cy + math.sin(a) * r1],
               fill=(210, 220, 229, 190 if i % 3 == 0 else 110),
               width=max(1, S // 230))

    # 对角计算线 + 中心核（品牌标记）
    d.line([S * 0.30, S * 0.70, S * 0.70, S * 0.30], fill=(232, 238, 245, 210),
           width=max(3, S // 90))
    d.ellipse([cx - S * 0.045, cy - S * 0.045, cx + S * 0.045, cy + S * 0.045],
              fill=(238, 243, 249, 255))
    # 核心微光
    for k, alpha in ((0.085, 60), (0.13, 26)):
        d.ellipse([cx - S * k, cy - S * k, cx + S * k, cy + S * k],
                  outline=(210, 220, 229, alpha), width=max(1, S // 200))

    # 左下 / 右上两个节点，呼应五路分发
    for nx, ny, rad in ((S * 0.285, S * 0.715, 0.026), (S * 0.715, S * 0.285, 0.020)):
        d.ellipse([nx - S * rad, ny - S * rad, nx + S * rad, ny + S * rad],
                  fill=(210, 220, 229, 235))
    return img


def main():
    OUT_DIR.mkdir(exist_ok=True)
    master = draw_master()
    png = OUT_DIR / "nexus-512.png"
    master.save(png)
    ico = OUT_DIR / "nexus.ico"
    master.save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("icon:", ico, ico.stat().st_size, "bytes; png:", png)


if __name__ == "__main__":
    main()
