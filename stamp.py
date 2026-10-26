"""Stamp a fresh version on the asset links in index.html. Run before every deploy.

GitHub Pages lets browsers cache files for 10 minutes. Without a version, a browser can pair
the new index.html with an old cached app.js and break (e.g. "Cannot set properties of null").
A new ?v= on each deploy makes the new page always fetch the matching code.

Run: python3 stamp.py
"""
import re
import time
from pathlib import Path

page = Path(__file__).parent / "index.html"
v = time.strftime("%Y%m%d%H%M")
html = re.sub(r'((?:src|href)="(?:books/index\.js|parse\.js|app\.js|style\.css))(?:\?v=\w+)?"', rf'\1?v={v}"', page.read_text())
page.write_text(html)
print("stamped", v)
