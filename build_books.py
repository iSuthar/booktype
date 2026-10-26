"""Turn Project Gutenberg .txt files in raw/ into books/<slug>.js.

Only strips the Gutenberg licence header/footer. All parsing (paragraphs,
chapters, character cleanup) happens in app.js, so bundled books and books
the reader uploads go through the same code.

Run: python3 build_books.py
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
BOOKS = [
    # gutenberg id, slug, title, author
    (1342, "pride-and-prejudice", "Pride and Prejudice", "Jane Austen"),
    (11, "alice", "Alice's Adventures in Wonderland", "Lewis Carroll"),
    (84, "frankenstein", "Frankenstein", "Mary Shelley"),
    (35, "time-machine", "The Time Machine", "H. G. Wells"),
    (1661, "sherlock-holmes", "The Adventures of Sherlock Holmes", "Arthur Conan Doyle"),
]

START = re.compile(r"\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.I)
END = re.compile(r"\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG", re.I)


def strip_gutenberg(text: str) -> str:
    text = text.replace("\r\n", "\n")
    m = START.search(text)
    if m:
        text = text[m.end():]
    m = END.search(text)
    if m:
        text = text[: m.start()]
    return text.strip()


def main() -> None:
    out_dir = ROOT / "books"
    out_dir.mkdir(exist_ok=True)
    index = []
    for gid, slug, title, author in BOOKS:
        text = strip_gutenberg((ROOT / "raw" / f"{gid}.txt").read_text(encoding="utf-8"))
        meta = {"id": slug, "title": title, "author": author, "source": f"Project Gutenberg #{gid}"}
        payload = dict(meta, text=text)
        (out_dir / f"{slug}.js").write_text(
            f"window.__bookLoaded({json.dumps(payload, ensure_ascii=False)});\n", encoding="utf-8"
        )
        index.append(dict(meta, chars=len(text)))
        print(f"{slug}: {len(text):,} chars")
    (out_dir / "index.js").write_text(
        f"window.BOOK_INDEX = {json.dumps(index, ensure_ascii=False, indent=1)};\n", encoding="utf-8"
    )
    # page + chapter counts come from the site's own parser (parse.js), so they match the reader
    subprocess.run(["node", str(ROOT / "build_index.js")], check=True)


if __name__ == "__main__":
    main()
