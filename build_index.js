// Adds page and chapter counts to books/index.js (run by build_books.py after it writes the books).
// Uses the same parser and pagination as the site, so the numbers match what readers see.
"use strict";
const fs = require("fs");
const path = require("path");
const { parsePlainText, paginate } = require("./parse.js");

const dir = path.join(__dirname, "books");
const load = (file) => {
  let out;
  new Function("window", fs.readFileSync(file, "utf8"))({ set BOOK_INDEX(v) { out = v; }, __bookLoaded: (v) => { out = v; } });
  return out;
};
const index = load(path.join(dir, "index.js"));
for (const b of index) {
  const { paras, chapters, startP } = parsePlainText(load(path.join(dir, b.id + ".js")).text);
  b.pages = paginate(paras, startP).length;
  b.chapters = chapters.filter((c) => c.p >= startP).length;
  console.log(`${b.id}: ${b.pages} pages, ${b.chapters} chapters`);
}
fs.writeFileSync(path.join(dir, "index.js"), `window.BOOK_INDEX = ${JSON.stringify(index, null, 1)};\n`);
