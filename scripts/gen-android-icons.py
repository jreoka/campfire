#!/usr/bin/env python3
"""Regenerate Android launcher icons (Pillow-based twin of gen-android-icons.js).

Prefer the JS script (zero dependencies, what CI and the docs use); this one
exists for anyone working in Python. Both produce the same artwork:

- Adaptive foreground: the BARE campfire mark on transparency, inside the
  72dp safe circle of the 108dp layer.
- Legacy + round icons: the badge (mark on the theme-colored circle) at full
  size, so old and modern launchers agree.
- Adaptive background color: the theme navy.

Requires Pillow:  pip install pillow
Run from the repo root:  python3 scripts/gen-android-icons.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow required: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = os.path.join(ROOT, "public", "icons", "campfire-logo.png")
BADGE = os.path.join(ROOT, "public", "icons", "campfire-badge.png")
RES = os.path.join(ROOT, "app", "src-tauri", "gen", "android", "app", "src", "main", "res")
BG = (0x1A, 0x1D, 0x29, 255)  # app background / theme-color

DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def load(path, trim=True):
    im = Image.open(path).convert("RGBA")
    if not trim:
        return im
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im


def place(canvas, art, frac):
    w = int(min(canvas.size) * frac)
    lg = art.resize((w, int(w * art.height / art.width)), Image.LANCZOS)
    canvas.alpha_composite(lg, ((canvas.width - lg.width) // 2, (canvas.height - lg.height) // 2))
    return canvas


def main():
    mark = load(MARK)
    badge = load(BADGE, trim=False)  # keep the badge's own transparent margin
    for name, scale in DENS.items():
        d = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(d, exist_ok=True)
        # adaptive foreground layer: 108dp, bare mark inside the safe circle
        fg_px = int(108 * scale)
        fg = Image.new("RGBA", (fg_px, fg_px), (0, 0, 0, 0))
        place(fg, mark, 66 / 108)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))
        # legacy + round icons: the badge at full size (flat, resp. masked)
        px = int(48 * scale)
        for fname, full_bleed in (("ic_launcher.png", True), ("ic_launcher_round.png", False)):
            canvas = Image.new("RGBA", (px, px), BG if full_bleed else (0, 0, 0, 0))
            place(canvas, badge, 1.0)
            canvas.save(os.path.join(d, fname))
    with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#1a1d29</color>\n</resources>')
    print("android launcher icons regenerated")


if __name__ == "__main__":
    main()
