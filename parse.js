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

if (typeof module !== "undefined") module.exports = { parsePlainText, cleanPara, finalize };
