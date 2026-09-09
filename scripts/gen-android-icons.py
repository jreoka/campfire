#!/usr/bin/env python3
"""Regenerate Android launcher icons from public/icons/campfire-logo.png.

- Adaptive foreground: campfire mark on transparency, artwork inside the
  66dp safe circle of the 108dp layer (no more zoomed-in/cropped logo).
- Legacy + round icons: mark on the app dark-navy background.
- Adaptive background color: the same dark navy (no more white square).

Requires Pillow:  pip install pillow
Run from the repo root:  python3 scripts/gen-android-icons.py
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow required: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "icons", "campfire-logo.png")
RES = os.path.join(ROOT, "app", "src-tauri", "gen", "android", "app", "src", "main", "res")
BG = (0x1A, 0x1D, 0x29, 255)  # app background / theme-color

DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def load_logo():
    im = Image.open(SRC).convert("RGBA")
    # trim transparent margins so sizing is relative to the artwork itself
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    return im


def place(canvas, logo, frac):
    w = int(min(canvas.size) * frac)
    lg = logo.resize((w, int(w * logo.height / logo.width)), Image.LANCZOS)
    canvas.alpha_composite(lg, ((canvas.width - lg.width) // 2, (canvas.height - lg.height) // 2))
    return canvas


def main():
    logo = load_logo()
    for name, scale in DENS.items():
        d = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(d, exist_ok=True)
        # adaptive foreground layer: 108dp, artwork in the central 66dp
        fg_px = int(108 * scale)
        fg = Image.new("RGBA", (fg_px, fg_px), (0, 0, 0, 0))
        place(fg, logo, 66 / 108)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))
        # legacy icon: 48dp full-bleed dark + mark
        px = int(48 * scale)
        legacy = Image.new("RGBA", (px, px), BG)
        place(legacy, logo, 0.72)
        legacy.save(os.path.join(d, "ic_launcher.png"))
        # round icon: dark circle + mark, transparent corners
        rnd = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        ImageDraw.Draw(rnd).ellipse([0, 0, px - 1, px - 1], fill=BG)
        place(rnd, logo, 0.62)
        rnd.save(os.path.join(d, "ic_launcher_round.png"))
    with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#1a1d29</color>\n</resources>')
    print("android launcher icons regenerated")


if __name__ == "__main__":
    main()
