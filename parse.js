// Book parsing: raw text / EPUB -> { paras: [{t, h}], chapters: [{title, p}], startP }.
// t = paragraph text, h = true for headings (shown, never typed).
// Works in the browser and in node (for tests).
"use strict";

const CHAR_MAP = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[–—―−]/g, "-"],
  [/…/g, "..."],
  [/æ/g, "ae"], [/Æ/g, "Ae"], [/œ/g, "oe"], [/Œ/g, "Oe"],
  [/[­​-‍﻿]/g, ""],
  [/[  - 　]/g, " "],
  [/[_*]/g, ""], // Gutenberg marks italics as _word_ and breaks as * * *
];

const HEADING_RE =
  /^(?:(?:chapter|letter|book|part|stave|volume|adventure)\s+(?:[ivxlcdm]+|\d+)\b|[IVXLC]+\.(?:\s|$))/i;
const MAX_HEADING = 70;
const MIN_CHAPTER_CHARS = 200; // a heading followed by less text than this is a table-of-contents line

function cleanPara(s) {
  for (const [re, r] of CHAR_MAP) s = s.replace(re, r);
  return s.replace(/\s+/g, " ").trim();
}

function stripGutenberg(t) {
  const s = t.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG/i);
  if (s >= 0) t = t.slice(t.indexOf("\n", s) + 1);
  const e = t.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (e >= 0) t = t.slice(0, e);
  return t;
}

function parsePlainText(raw) {
  const t = stripGutenberg(raw.replace(/\r\n?/g, "\n"));
  const paras = [];
  for (const block of t.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0];
    if (/^\[(illustration|transcriber)/i.test(first)) continue;
    if (HEADING_RE.test(first) && first.length < MAX_HEADING) {
      if (lines.length <= 3 && lines.every((l) => l.length < MAX_HEADING)) {
        paras.push({ t: cleanPara(lines.join(" ")), h: true });
        continue;
      }
      // many heading-looking lines in one block = table of contents
      if (lines.filter((l) => HEADING_RE.test(l)).length >= lines.length / 2) continue;
    }
    paras.push({ t: cleanPara(lines.join(" ")), h: false });
  }
  return finalize(paras);
}

// EPUB: needs JSZip and DOMParser (browser only).
async function parseEpub(arrayBuffer, JSZip) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const read = (p) => zip.file(decodeURIComponent(p))?.async("string");
  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");

  const container = xml(await read("META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile").getAttribute("full-path");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = xml(await read(opfPath));

  const title = opf.querySelector("metadata > title, title")?.textContent?.trim();
  const author = opf.querySelector("metadata > creator, creator")?.textContent?.trim();
  const manifest = {};
  for (const item of opf.querySelectorAll("manifest > item")) {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  }

  const paras = [];
  for (const ref of opf.querySelectorAll("spine > itemref")) {
    const href = manifest[ref.getAttribute("idref")];
    if (!href) continue;
    const html = await read(base + href.split("#")[0]);
    if (!html) continue;
    let doc = new DOMParser().parseFromString(html, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of doc.querySelectorAll("h1,h2,h3,h4,p,li,blockquote")) {
      if (el.querySelector("h1,h2,h3,h4,p,li")) continue; // container; its children are visited
      const t = cleanPara(el.textContent || "");
      if (!t) continue;
      const isHeading = /^H\d$/i.test(el.tagName) && t.length < MAX_HEADING * 2;
      paras.push({ t, h: isHeading });
    }
  }
  return { title, author, ...finalize(paras) };
}

const BARE_HEADING_RE = /^(?:[a-z]+\s+)?[ivxlcdm\d]+\.?$/i;

function finalize(paras) {
  paras = paras.filter((p) => p.t);
  const end = paras.findIndex((p) => /END OF (THE|THIS) PROJECT GUTENBERG/i.test(p.t));
  if (end > 0) paras = paras.slice(0, end);
  for (const p of paras) if (p.h) p.t = p.t.replace(/[\[\]]/g, "").trim();
  // If some headings carry a title ("I. A SCANDAL IN BOHEMIA"), bare ones ("I.") are sub-sections.
  const heads = paras.map((p, i) => (p.h ? i : -1)).filter((i) => i >= 0);
  const titled = heads.some((i) => HEADING_RE.test(paras[i].t) && !BARE_HEADING_RE.test(paras[i].t));
  const eligible = heads.filter((i) => !titled || !BARE_HEADING_RE.test(paras[i].t));
  const chapters = [];
  eligible.forEach((i, k) => {
    const next = k + 1 < eligible.length ? eligible[k + 1] : paras.length;
    let n = 0;
    for (let j = i + 1; j < next && n < MIN_CHAPTER_CHARS; j++) if (!paras[j].h) n += paras[j].t.length;
    if (n >= MIN_CHAPTER_CHARS) chapters.push({ title: paras[i].t, p: i });
  });
  const firstText = paras.findIndex((p) => !p.h);
  // start at the first real chapter, skipping title pages, contents and prefaces
  const first = chapters.find((c) => HEADING_RE.test(c.title)) || chapters[0];
  return { paras, chapters, startP: first ? first.p : Math.max(0, firstText) };
}

// ---------- pages ----------
const PAGE_CHARS = 1100; // typed characters per page, about one printed page

// One page starting at paragraph p0. Chapters (any heading) always start a new page.
function buildPage(paras, p0) {
  const items = [];
  let p = p0, n = 0;
  while (p < paras.length) {
    const para = paras[p];
    if (para.h) {
      if (n > 0) break;
      items.push(p++);
      continue;
    }
    if (n > 0 && n + para.t.length > PAGE_CHARS * 1.4) break;
    items.push(p++);
    n += para.t.length;
    if (n >= PAGE_CHARS) break;
  }
  return { start: p0, end: p, items };
}

// first paragraph of every page from the start of the book (startP) to the end
function paginate(paras, startP) {
  const starts = [];
  for (let p = startP; p < paras.length; p = buildPage(paras, p).end) starts.push(p);
  return starts;
}

// "CHAPTER XIII" / "Chapter I." / "IV. THE BOSCOMBE VALLEY MYSTERY" -> "Chapter 13" / "Chapter 1" / "Chapter 4: The Boscombe Valley Mystery"
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function fromRoman(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]], next = ROMAN[s[i + 1]] || 0;
    n += v < next ? -v : v;
  }
  return n;
}
const SMALL_WORDS = /^(a|an|and|at|by|for|in|of|on|or|the|to|with)$/;
function titleCase(s) {
  if (/[a-z]/.test(s)) return s; // already mixed case: keep the author's casing
  return s.toLowerCase().replace(/[a-z][\w'-]*/g, (w, i) => (i && SMALL_WORDS.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
}
function chapterTitle(t) {
  const m = t.match(/^(?:(chapter|letter|book|part|stave|volume|adventure)\s+)?([ivxlcdm]+|\d+)\b\.?\s*(.*)$/i);
  if (!m || (!m[1] && !/^[ivxlc]+\./i.test(t))) return titleCase(t);
  const word = m[1] ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : "Chapter";
  const n = /^\d+$/.test(m[2]) ? +m[2] : fromRoman(m[2].toLowerCase());
  const rest = m[3].replace(/^[-:.\s]+/, "");
  return `${word} ${n}` + (rest ? ": " + titleCase(rest) : "");
}

if (typeof module !== "undefined") module.exports = { parsePlainText, cleanPara, finalize, chapterTitle, buildPage, paginate };
