#!/usr/bin/env python3
"""Generate electron/assets/icon.ico from electron/assets/icon.png.

The .ico file is intentionally not committed (binary): the Windows cloud
build runs this script before packaging, and local Windows packagers can
run it once too. Requires Pillow: pip install pillow
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
src = ROOT / "electron" / "assets" / "icon.png"
dst = ROOT / "electron" / "assets" / "icon.ico"
im = Image.open(src)
im.save(dst, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(f"wrote {dst} ({dst.stat().st_size} bytes)")
