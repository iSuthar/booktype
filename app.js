"use strict";
// booktype: type through a book, page by page.
// Engine design follows monkeytype: a hidden <textarea> receives `beforeinput`
// events (works with mobile keyboards), every letter is its own <span>, and a
// separately positioned caret glides between them. WPM = (correct chars / 5) / minutes.

const $ = (s) => document.querySelector(s);

const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem("bt:" + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("bt:" + k, JSON.stringify(v)); return true; } catch { return false; }
  },
};

const IDLE_MS = 4000;   // pauses longer than this (reading, thinking) don't count against WPM
const THEMES = ["serika-dark", "serika", "nord", "dracula", "paper", "matrix"];
const MIN_WPM_MS = 2000; // don't show live wpm until this much typing time (avoids silly first numbers)
const MIN_RESULT_CHARS = 100; // chapters typed less than this skip the results screen
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
// Analytics: sign up at goatcounter.com, put your site code here (e.g. "booktype").
const GOATCOUNTER_CODE = "isuthar";
const FIRST_BOOK = "alice"; // opened on a first visit

const S = {
  book: null,
  pos: { p: 0, c: 0 },  // current paragraph + character in it
  page: null,           // { start, end, items }
  chars: [],            // [{ ch, p, i, el, typed }]
  k: 0,                 // caret index into chars
  minK: 0,              // can't backspace before this (resume point)
  last: 0,              // time of last keystroke
  session: { ms: 0, chars: 0, keys: 0, correct: 0 },
  chap: null,           // stats for the chapter being typed (see newChap)
  pageStart: null,      // session snapshot at page start
  p0: null,             // chapter snapshot at paragraph start
  w0: null,             // { ms, k, clean } at word start
  strict: store.get("strict", false),
  font: store.get("font", "book"),
  view: store.get("view", "page"),
  size: store.get("size", "m"), // text size: s / m / l // "page" = whole book page, "focus" = monkeytype-style 5 lines
  theme: store.get("theme", "serika-dark"),
  goal: store.get("goal", 3),
};

const books = {}; // id -> parsed book (memory cache)

// ---------- helpers ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = el("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load " + src));
    document.head.append(s);
  });
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function track(name) {
  try { window.goatcounter?.count?.({ path: "event/" + name, title: name, event: true }); } catch {}
}
if (GOATCOUNTER_CODE) {
  const s = el("script");
  s.async = true;
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  s.src = "https://gc.zgo.at/count.js";
  document.head.append(s);
}

const fold = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "");
const isBreak = (c) => c.ch === " " || c.ch === "\n";

function isMatch(expected, got) {
  if (expected === "\n") return got === " " || got === "\n";
  if (expected === got) return true;
  const f = fold(expected);
  if (f === got) return true;              // é accepts e
  return !/^[\x20-\x7e]+$/.test(f);        // symbols not on a keyboard (£, ½) accept any key
}

function wpm(chars, ms) { return ms > 0 ? Math.round(chars / 5 / (ms / 60000)) : 0; }
function acc(correct, keys) { return keys ? Math.round((correct / keys) * 100) : 100; }
function fmtTime(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ---------- daily goal + streak ----------

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function days() { return store.get("days", {}); }
function pagesToday() { return days()[dayKey()] || 0; }

// consecutive days that met the goal, ending today (or yesterday if today isn't done yet)
function streak() {
  const d = days(), day = new Date();
  if ((d[dayKey(day)] || 0) < S.goal) day.setDate(day.getDate() - 1);
  let n = 0;
  while ((d[dayKey(day)] || 0) >= S.goal) { n++; day.setDate(day.getDate() - 1); }
  return n;
}

// returns true when this page completed today's goal
function addPage() {
  const d = days(), k = dayKey();
  d[k] = (d[k] || 0) + 1;
  store.set("days", d);
  return d[k] === S.goal;
}

// ---------- books ----------

function prepare(id, title, author, parsed) {
  const { paras, startP } = parsed;
  const chapters = parsed.chapters.filter((c) => c.p >= startP).map((c) => ({ ...c, title: chapterTitle(c.title) }));
  for (const c of chapters) paras[c.p] = { ...paras[c.p], t: c.title };
  const cum = [0];
  for (const p of paras) cum.push(cum.at(-1) + (p.h ? 0 : p.t.length));
  const book = { id, title, author, paras, chapters, startP, cum, total: cum.at(-1), pages: paginate(paras, startP) };
  // first page and page count of each chapter
  chapters.forEach((c, i) => {
    c.page = Math.max(0, pageOf(book, c.p));
    c.pages = (i + 1 < chapters.length ? pageOf(book, chapters[i + 1].p) : book.pages.length) - c.page;
  });
  return book;
}

// index of the page holding paragraph p (-1 before the book's first page)
function pageOf(book, p) {
  let lo = 0, hi = book.pages.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (book.pages[mid] <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

async function getBook(id) {
  if (books[id]) return books[id];
  if (id.startsWith("u-")) {
    const saved = store.get("book:" + id);
    if (!saved) throw new Error("This book is no longer saved in your browser. Open the file again.");
    return (books[id] = prepare(id, saved.title, saved.author, saved));
  }
  const meta = window.BOOK_INDEX.find((b) => b.id === id);
  if (!meta) throw new Error("unknown book " + id);
  const raw = await new Promise((resolve, reject) => {
    window.__bookLoaded = resolve;
    loadScript(`books/${id}.js`).catch(reject);
  });
  return (books[id] = prepare(id, meta.title, meta.author, parsePlainText(raw.text)));
}

function uploads() { return store.get("uploads", []); }

async function openFile(file) {
  toast("Opening " + file.name + "…", 8000);
  let parsed, title, author = "";
  if (/\.epub$/i.test(file.name)) {
    if (!window.JSZip) await loadScript(JSZIP_URL);
    parsed = await parseEpub(await file.arrayBuffer(), window.JSZip);
    title = parsed.title; author = parsed.author || "";
  } else {
    const text = await file.text();
    parsed = parsePlainText(text);
    title = (text.match(/^Title:\s*(.+)$/m) || [])[1];
    author = (text.match(/^Author:\s*(.+)$/m) || [])[1] || "";
  }
  title = (title || file.name.replace(/\.[^.]+$/, "")).trim();
  if (!parsed.paras.some((p) => !p.h)) throw new Error("No readable text found in " + file.name);

  const id = "u-" + Math.abs([...title + parsed.paras.length].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
  const saved = store.set("book:" + id, { title, author, paras: parsed.paras, chapters: parsed.chapters, startP: parsed.startP });
  const book = (books[id] = prepare(id, title, author, parsed));
  if (saved) {
    const meta = { id, title, author, pages: book.pages.length, chapters: book.chapters.length };
    store.set("uploads", [meta, ...uploads().filter((u) => u.id !== id)]);
  }
  if (!saved) toast("Too big to save in this browser: open the file again next visit.", 5000);
  track("upload");
  await openBook(id);
}

// ---------- library ----------

function progressOf(id) { return store.get("progress:" + id); }

// generated cover: book-cloth colour picked from the title, so every book keeps its own
const COVERS = ["#7a2e2e", "#2e4a7a", "#2e6b4f", "#6b552e", "#55306b", "#2e6670", "#704a2e", "#3d3d5c"];
function cover(b, small) {
  const c = el("div", "cover" + (small ? " small" : ""));
  const h = [...b.title].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0);
  c.style.setProperty("--cover", COVERS[Math.abs(h) % COVERS.length]);
  if (small) {
    // too small for a title: one big initial, like a monogrammed spine
    c.append(el("span", "ct", b.title.replace(/^(the|a|an)\s+/i, "")[0] || "?"));
  } else {
    c.append(el("span", "ct", b.title), el("span", "ca", b.author || ""));
  }
  return c;
}

function leaveReader() {
  closeSettings();
  if ($("#reader").hidden) return;
  savePos();
  saveChap();
}

function showLibrary() {
  leaveReader();
  show("library");
  updateStreak();
  const st = streak(), today = pagesToday();
  $("#streakline").textContent = st || today
    ? (st ? `${st}-day streak · ` : "") + `${Math.min(today, S.goal)}/${S.goal} pages today` + (today >= S.goal ? " · goal done" : "")
    : "";

  const grid = $("#grid");
  grid.innerHTML = "";
  const all = [...uploads(), ...window.BOOK_INDEX];
  const last = store.get("last");
  all.sort((a, b) => (b.id === last) - (a.id === last));
  for (const b of all) {
    const pr = progressOf(b.id);
    const card = el("button", "card");
    const info = el("div", "info");
    info.append(el("span", "t", b.title), el("span", "a", b.author || ""));
    const meta = el("span", "meta");
    if (pr) {
      const bar = el("div", "bar"), fill = el("i");
      fill.style.width = (pr.pct || 0).toFixed(1) + "%";
      bar.append(fill);
      meta.append(`${(pr.pct || 0).toFixed(0)}% read` + (pr.ms > 10000 ? ` · ${wpm(pr.chars, pr.ms)} wpm` : ""), bar);
    } else {
      if (b.pages) meta.append(el("span", null, `${b.pages} pages`), el("span", null, `${b.chapters} chapters`));
      else meta.textContent = "your book";
    }
    info.append(meta);
    card.append(cover(b, true), info);
    card.onclick = () => showBook(b.id).catch((e) => toast(e.message, 5000));
    grid.append(card);
  }
  const add = el("button", "card add");
  add.append(el("span", "t", "+"), el("span", "a", "Open your own .txt or .epub"));
  add.onclick = () => $("#file").click();
  grid.append(add);
  grid.firstChild.focus({ preventScroll: true }); // Enter opens the last book you read
}

// Book page: cover, progress and the chapter list (typelit-style), between the library and typing.
async function showBook(id) {
  const book = await getBook(id);
  leaveReader();
  const pr = progressOf(id);
  const p = pr ? pr.p : null;
  const curCh = p == null ? -1 : book.chapters.findLastIndex((c) => c.p <= p);
  const curPage = p == null ? -1 : Math.max(0, pageOf(book, p));

  $("#bv-cover").replaceChildren(cover(book));
  $("#bv-title").textContent = book.title;
  $("#bv-author").textContent = book.author || "";
  const pct = pr ? pr.pct || 0 : 0;
  const bits = [
    `${Math.max(0, curCh)} / ${book.chapters.length} chapters`,
    pr ? `page ${curPage + 1} of ${book.pages.length}` : `${book.pages.length} pages`,
    `${pct.toFixed(0)}% read`,
  ];
  if (pr && pr.ms > 10000) bits.push(`${wpm(pr.chars, pr.ms)} wpm`);
  $("#bv-stats").textContent = bits.join(" · ");
  $("#bv-bar").style.width = pct.toFixed(1) + "%";
  const ch = book.chapters[curCh];
  $("#bv-go").textContent = pr && ch ? `continue · ${ch.title.split(":")[0]}, page ${curPage - ch.page + 1}` : "start reading";
  $("#bv-go").onclick = () => openBook(id);

  const list = $("#bv-chapters");
  list.innerHTML = "";
  book.chapters.forEach((c, i) => {
    const li = el("li"), b = el("button", i < curCh ? "done" : i === curCh ? "cur" : "");
    const [num, name] = c.title.split(/:\s*(.*)/);
    b.append(el("span", "num", num), el("span", "name", name || ""));
    const state = i < curCh ? "✓" : i === curCh ? `page ${curPage - c.page + 1} of ${c.pages}` : `${c.pages} pages`;
    b.append(el("span", "pg", state));
    b.onclick = () => openBook(id, c.p);
    li.append(b);
    list.append(li);
  });
  show("bookview");
  window.scrollTo(0, 0);
  $("#bv-go").focus({ preventScroll: true });
}

function show(view) {
  for (const v of ["library", "bookview", "reader", "results", "done"]) $("#" + v).hidden = v !== view;
  document.body.dataset.view = view;
}

// ---------- reading ----------

// % of the book read at paragraph p, character c (front matter before chapter 1 doesn't count)
function pctAt(p, c) {
  const b = S.book, s = b.cum[b.startP] || 0;
  return b.total > s ? Math.max(0, ((b.cum[Math.min(p, b.paras.length)] + c - s) / (b.total - s)) * 100) : 0;
}

function chapterIdx(p) { return S.book.chapters.findLastIndex((c) => c.p <= p); }

function newChap(idx) {
  const ch = S.book.chapters[idx];
  return {
    book: S.book.id, idx, title: ch ? ch.title : S.book.title,
    ms: 0, chars: 0, keys: 0, correct: 0,
    paras: [],  // wpm of each finished paragraph, in order
    words: {},  // word -> slowest wpm it was typed at
  };
}

function saveChap() { if (S.chap) store.set("chap:" + S.chap.book, S.chap); }

// counters live in both the session and the current chapter
function add(field, n = 1) {
  S.session[field] += n;
  if (S.chap) S.chap[field] += n;
}

// open a book where the reader left off, or at paragraph `at` (a chapter picked on the book page)
async function openBook(id, at) {
  const book = await getBook(id);
  S.book = book;
  store.set("last", id);
  const pr = progressOf(id);
  S.pos = pr && pr.p < book.paras.length ? { p: pr.p, c: pr.c } : { p: book.startP, c: 0 };
  S.chap = store.get("chap:" + id);
  if (at != null) {
    S.pos = { p: at, c: 0 };
    savePos(true);
  }
  $("#cr-book").textContent = book.title;
  track("open");
  show("reader");
  loadPage();
}

function loadPage() {
  const book = S.book;
  show("reader");
  if (S.pos.p >= book.paras.length) return finishBook();
  const pi = pageOf(book, S.pos.p);
  S.page = buildPage(book.paras, pi >= 0 ? book.pages[pi] : S.pos.p);
  S.page.no = pi;
  if (!S.page.items.some((i) => !book.paras[i].h)) return finishBook();

  const idx = chapterIdx(S.pos.p);
  if (!S.chap || S.chap.book !== book.id || S.chap.idx !== idx) S.chap = newChap(idx);

  const text = $("#text");
  text.innerHTML = "";
  text.scrollTop = 0;
  S.chars = [];
  for (const i of S.page.items) {
    const para = book.paras[i];
    if (para.h) {
      // "Chapter 1: Down the Rabbit-Hole" -> number line + title line (a book page shows them stacked)
      const h = el("h2"), [num, name] = para.t.split(/:\s*(.*)/);
      h.append(el("span", "num", num));
      if (name) h.append(el("span", "name", name));
      text.append(h);
      continue;
    }
    const pe = el("p");
    const words = para.t.split(" ");
    let ci = 0;
    words.forEach((w, wi) => {
      const we = el("span", "w");
      for (const ch of w) {
        const ce = el("span", "c", ch);
        we.append(ce);
        S.chars.push({ ch, p: i, i: ci++, el: ce });
      }
      pe.append(we);
      if (wi < words.length - 1) {
        const se = el("span", "c s", " ");
        pe.append(se);
        S.chars.push({ ch: " ", p: i, i: ci++, el: se });
      }
    });
    const nl = el("span", "c nl", "↵");
    pe.append(nl);
    S.chars.push({ ch: "\n", p: i, i: ci, el: nl });
    text.append(pe);
  }
  const spacer = el("div", "spacer"); // focus layout: room below the last line so it can scroll up to line 2
  spacer.style.height = "calc(var(--lh) * (var(--lines) - 1))";
  text.append(spacer);
  const caret = el("div");
  caret.id = "caret";
  text.append(caret);

  // resume mid-paragraph: earlier letters show as already read
  S.k = S.chars.findIndex((c) => c.p > S.pos.p || (c.p === S.pos.p && c.i >= S.pos.c));
  if (S.k < 0) S.k = 0;
  for (let j = 0; j < S.k; j++) S.chars[j].el.classList.add("read");
  S.minK = S.k;
  S.pageStart = { ...S.session };
  S.p0 = { chars: S.chap.chars, ms: S.chap.ms };
  S.w0 = { ms: S.chap.ms, k: S.k, clean: true };

  const ch = book.chapters[idx];
  $("#cr-chap").textContent = ch ? ch.title : "";
  if (S.view === "page") window.scrollTo(0, 0);

  moveCaret(true);
  updateStats();
  focusInput();
}

// Lines in the text box are all exactly --lh tall, so the caret's line is
// found by rounding, and the box scrolls a whole line at a time.
function moveCaret(instant) {
  const c = S.chars[S.k];
  const caret = $("#caret");
  if (!c || !caret) return;
  const e = c.el, box = $("#text");
  if (S.view === "page") return movePageCaret(c, caret, instant);
  const L = parseFloat(getComputedStyle(box).lineHeight);
  const fs = parseFloat(getComputedStyle(box).fontSize);
  const lineTop = Math.floor((e.offsetTop + e.offsetHeight / 2) / L) * L;
  const h = fs * 1.15;
  if (instant) caret.style.transition = "none";
  caret.style.transform = `translate(${e.offsetLeft - 1}px, ${lineTop + (L - h) / 2}px)`;
  caret.style.height = h + "px";
  if (instant) { void caret.offsetWidth; caret.style.transition = ""; }

  // keep the caret on the second visible line
  // (on the page's first text line, stay at the top so chapter headings above it stay visible)
  const firstP = box.querySelector("p");
  const target = firstP && lineTop <= firstP.offsetTop ? 0 : Math.max(0, lineTop - L);
  if (Math.abs(box.scrollTop - target) > 1) box.scrollTo({ top: target, behavior: instant ? "auto" : "smooth" });
}

// Book-page layout: the caret sits on the letter. Once it passes 40% of the screen, the page scrolls
// line by line so the line you type stays at the same height (eyes stay put on a laptop screen).
function movePageCaret(c, caret, instant) {
  // the paragraph-end mark is smaller, so take the height from the letter before it
  const prev = S.chars[S.k - 1];
  const ref = c.ch === "\n" && prev && prev.p === c.p ? prev.el : c.el;
  const h = ref.offsetHeight;
  if (instant) caret.style.transition = "none";
  caret.style.transform = `translate(${c.el.offsetLeft - 1}px, ${ref.offsetTop}px)`;
  caret.style.height = h + "px";
  if (instant) { void caret.offsetWidth; caret.style.transition = ""; }
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const y = ref.getBoundingClientRect().top, line = vh * 0.4;
  const hidden = y < $("#rbar").getBoundingClientRect().bottom + 8; // under the sticky top bar
  if (y > line + 2 || hidden) window.scrollTo({ top: Math.max(0, window.scrollY + y - line), behavior: instant ? "auto" : "smooth" });
}

function tick() {
  const now = performance.now();
  if (S.last && now - S.last < IDLE_MS) add("ms", now - S.last);
  S.last = now;
  document.body.classList.add("typing", "focus");
  closeSettings();
  $("#hint").hidden = true;
  clearTimeout(tick.t);
  tick.t = setTimeout(() => document.body.classList.remove("typing"), 600);
}

function shake(c) {
  c.el.classList.remove("shake");
  void c.el.offsetWidth;
  c.el.classList.add("shake");
}

function typeChar(ch) {
  const cur = S.chars[S.k];
  if (!cur) return;
  if (ch === " " && !isBreak(cur) && !S.strict) {
    if (S.k === S.minK || isBreak(S.chars[S.k - 1])) return; // stray space before a word: ignore
    return skipWord();
  }
  tick();
  const ok = isMatch(cur.ch, ch);
  add("keys");
  if (ok) add("correct");
  if (!ok && S.strict) {
    shake(cur);
    updateStats();
    return;
  }
  cur.typed = ch;
  cur.el.classList.add(ok ? "ok" : "err");
  if (ok) add("chars");
  S.k++;
  afterAdvance(cur, ok);
}

// Space in the middle of a word: mark the rest of it missed and jump to the next word.
function skipWord() {
  tick();
  add("keys");
  S.w0.clean = false;
  while (S.k < S.chars.length && !isBreak(S.chars[S.k])) {
    const c = S.chars[S.k++];
    c.typed = "";
    c.el.classList.add("err", "miss");
  }
  const br = S.chars[S.k++];
  br.typed = " ";
  br.el.classList.add("ok");
  afterAdvance(br, false);
}

function afterAdvance(cur, ok) {
  if (isBreak(cur)) {
    markWord(S.k - 2);
    if (ok) endWord();
    if (cur.ch === "\n") endParagraph();
    S.w0 = { ms: S.chap.ms, k: S.k, clean: true };
    savePos();
  }
  if (S.k >= S.chars.length) return finishPage();
  moveCaret();
  updateStats();
}

// underline the word ending at index j if any of its letters are wrong (monkeytype style)
function markWord(j) {
  const end = S.chars[j];
  if (!end || isBreak(end)) return;
  let bad = false;
  for (; j >= 0 && !isBreak(S.chars[j]); j--) if (S.chars[j].el.classList.contains("err")) bad = true;
  end.el.parentElement.classList.toggle("werr", bad);
}

// record how fast the word just finished was typed (only clean, uncorrected words)
function endWord() {
  const w0 = S.w0;
  if (!w0 || !w0.clean) return;
  const word = S.chars.slice(w0.k, S.k - 1).map((c) => c.ch).join("");
  const key = word.toLowerCase().replace(/[^a-z']/g, "").replace(/^'+|'+$/g, "");
  const ms = S.chap.ms - w0.ms;
  if (key.length < 3 || ms <= 0) return;
  const w = wpm(word.length + 1, ms);
  if (!(key in S.chap.words) || w < S.chap.words[key]) S.chap.words[key] = w;
}

function endParagraph() {
  const chars = S.chap.chars - S.p0.chars, ms = S.chap.ms - S.p0.ms;
  if (chars >= 20 && ms > 1500) S.chap.paras.push(wpm(chars, ms));
  S.p0 = { chars: S.chap.chars, ms: S.chap.ms };
  saveChap();
}

function backspace(word) {
  if (S.k <= S.minK) return;
  tick();
  if (S.w0) S.w0.clean = false;
  do {
    const c = S.chars[--S.k];
    if (c.typed !== undefined && isMatch(c.ch, c.typed)) add("chars", -1);
    c.typed = undefined;
    c.el.classList.remove("ok", "err", "miss");
    c.el.parentElement.classList.remove("werr");
  } while (word && S.k > S.minK && !isBreak(S.chars[S.k - 1]));
  moveCaret();
  updateStats();
}

function skipParagraph() {
  const cur = S.chars[S.k];
  if (!cur) return;
  if (cur.p + 1 >= S.page.end) return advance(cur.p + 1);
  // jump the caret to the next paragraph on this page, marking the skipped part as read
  while (S.k < S.chars.length && S.chars[S.k].p === cur.p) S.chars[S.k++].el.classList.add("read");
  S.minK = S.k;
  S.p0 = { chars: S.chap.chars, ms: S.chap.ms };
  S.w0 = { ms: S.chap.ms, k: S.k, clean: true };
  savePos();
  moveCaret();
  updateStats();
}

// Move to paragraph p. If that ends the chapter (or the book), show the chapter results first.
function advance(p) {
  const from = chapterIdx(S.page.start);
  const to = p >= S.book.paras.length ? -2 : chapterIdx(p);
  S.pos = { p, c: 0 };
  savePos(true);
  saveChap();
  if (to !== from && S.chap && S.chap.chars >= MIN_RESULT_CHARS) return showResults(to === -2);
  loadPage();
}

function savePos(exact) {
  if (!S.book) return;
  if (!exact && S.chars.length) {
    let k = Math.min(S.k, S.chars.length - 1); // snap back to the start of the current word
    while (k > S.minK && !isBreak(S.chars[k - 1])) k--;
    const c = S.chars[k];
    if (c) S.pos = { p: c.p, c: c.i };
  }
  const prev = progressOf(S.book.id) || { chars: 0, ms: 0 };
  const pct = pctAt(S.pos.p, S.pos.c);
  // lifetime stats: add what this session typed since the last save
  const base = savePos.base || (savePos.base = { chars: 0, ms: 0 });
  const rec = {
    p: S.pos.p, c: S.pos.c, pct,
    chars: prev.chars + (S.session.chars - base.chars),
    ms: prev.ms + (S.session.ms - base.ms),
  };
  savePos.base = { chars: S.session.chars, ms: S.session.ms };
  store.set("progress:" + S.book.id, rec);
}

function finishPage() {
  const a = S.pageStart, s = S.session;
  const pw = wpm(s.chars - a.chars, s.ms - a.ms);
  const pa = acc(s.correct - a.correct, s.keys - a.keys);
  track("page");
  if (addPage()) {
    const st = streak();
    toast(`Daily goal done! ${st}-day streak`, 4500);
    $("#live").classList.add("pop");
    setTimeout(() => $("#live").classList.remove("pop"), 1200);
    track("goal");
  } else {
    toast(`page done · ${pw} wpm · ${pa}% acc`);
  }
  advance(S.page.end);
}

function finishBook() {
  savePos(true);
  const pr = progressOf(S.book.id) || {};
  $("#done-text").textContent =
    `You typed ${S.book.title}${pr.ms ? ` at an average of ${wpm(pr.chars, pr.ms)} wpm` : ""}.`;
  show("done");
}

function updateStats() {
  const s = S.session;
  $("#s-wpm").textContent = s.ms >= MIN_WPM_MS ? wpm(s.chars, s.ms) : "-";
  $("#s-acc").textContent = acc(s.correct, s.keys) + "%";
  const ch = S.book.chapters[chapterIdx(S.page.start)];
  $("#s-page").textContent = ch && S.page.no >= 0 ? `page ${S.page.no - ch.page + 1} of ${ch.pages}` : "";
  const today = pagesToday();
  $("#s-pages").textContent = `${Math.min(today, S.goal)}/${S.goal}`;
  $("#today").classList.toggle("on", today >= S.goal);
  $("#today").title = `pages today / daily goal${today >= S.goal ? " (done)" : ""}`;
  updateStreak();
}

function updateStreak() {
  const st = streak();
  $("#s-streak").textContent = st;
  $("#nav-streak").classList.toggle("on", st > 0);
  $("#nav-streak").title = `${st}-day streak (goal: ${S.goal} page${S.goal === 1 ? "" : "s"} a day)`;
}

// ---------- chapter results ----------

let resultsBookEnd = false;

function slowestWords(chap, n = 5) {
  const entries = Object.entries(chap.words);
  if (entries.length < 10) return [];
  return entries.sort((a, b) => a[1] - b[1]).slice(0, n);
}

function showResults(bookEnd) {
  resultsBookEnd = bookEnd;
  const ch = S.chap;
  track("chapter");
  show("results");
  $("#r-wpm").textContent = wpm(ch.chars, ch.ms);
  $("#r-acc").textContent = acc(ch.correct, ch.keys) + "%";
  const more = $("#r-more");
  more.innerHTML = "";
  const st = streak();
  for (const [l, v, cls] of [
    ["chapter", ch.title, "title"],
    ["time", fmtTime(ch.ms)],
    ["characters", ch.chars.toLocaleString()],
    ["streak", `${st} day${st === 1 ? "" : "s"}`],
  ]) {
    const d = el("div", cls);
    d.append(el("span", null, l), el("b", null, String(v)));
    more.append(d);
  }

  const chartWrap = $("#r-chart-wrap");
  chartWrap.hidden = ch.paras.length < 2;
  if (!chartWrap.hidden) {
    const avg = Math.round(ch.paras.reduce((a, b) => a + b, 0) / ch.paras.length);
    $("#r-chart").setAttribute("aria-label",
      `Words per minute for each of ${ch.paras.length} paragraphs. Average ${avg}, fastest ${Math.max(...ch.paras)}, slowest ${Math.min(...ch.paras)}.`);
    requestAnimationFrame(() => drawChart(-1));
  }

  const slow = slowestWords(ch);
  $("#r-slow-wrap").hidden = !slow.length;
  const box = $("#r-slow");
  box.innerHTML = "";
  for (const [w, v] of slow) {
    const chip = el("span", "chip");
    chip.append(el("b", null, w), el("span", null, `${v} wpm`));
    box.append(chip);
  }

  $("#r-next-l").textContent = bookEnd ? "finish book" : "next chapter";
  $("#r-next").focus();
}

function continueFromResults() {
  S.chap = null;
  loadPage();
}

// Line chart: wpm per paragraph. One series, so no legend; the heading names it.
const chart = { pts: [] };
function drawChart(hover) {
  const canvas = $("#r-canvas");
  const data = S.chap ? S.chap.paras : [];
  if (!canvas || data.length < 2) return;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);

  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const top = Math.max(...data);
  const step = top > 150 ? 50 : top > 60 ? 20 : 10;
  const max = Math.ceil((top * 1.1) / step) * step;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (data.length - 1);
  const y = (val) => pad.t + (1 - val / max) * (H - pad.t - pad.b);
  chart.pts = data.map((val, i) => ({ x: x(i), y: y(val), val, i }));

  g.font = `12px ${v("--font-mono")}`;
  g.lineWidth = 1;
  for (let val = 0; val <= max; val += step) {
    const yy = Math.round(y(val)) + 0.5;
    g.strokeStyle = v("--sub-alt");
    g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(W - pad.r, yy); g.stroke();
    g.fillStyle = v("--sub");
    g.textAlign = "right"; g.textBaseline = "middle";
    g.fillText(String(val), pad.l - 8, yy);
  }
  g.textBaseline = "alphabetic";
  g.textAlign = "left"; g.fillText("start of chapter (wpm per paragraph)", pad.l, H - 4);
  g.textAlign = "right"; g.fillText("end", W - pad.r, H - 4);

  if (hover >= 0) {
    const p = chart.pts[hover];
    g.strokeStyle = v("--sub");
    g.beginPath(); g.moveTo(Math.round(p.x) + 0.5, pad.t); g.lineTo(Math.round(p.x) + 0.5, H - pad.b); g.stroke();
  }

  g.strokeStyle = v("--main");
  g.lineWidth = 2;
  g.lineJoin = g.lineCap = "round";
  g.beginPath();
  chart.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.stroke();

  const tip = $("#r-tip");
  if (hover >= 0) {
    const p = chart.pts[hover];
    g.fillStyle = v("--bg");
    g.beginPath(); g.arc(p.x, p.y, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = v("--main");
    g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill();
    tip.hidden = false;
    tip.innerHTML = "";
    tip.append(el("b", null, `${p.val} wpm`), el("span", null, `paragraph ${p.i + 1}`));
    const left = Math.min(Math.max(p.x, 60), W - 60);
    tip.style.transform = `translate(calc(${left}px - 50%), ${Math.max(0, p.y - 58)}px)`;
  } else {
    tip.hidden = true;
  }
}

function chartHover(e) {
  if (!chart.pts.length) return;
  const r = $("#r-canvas").getBoundingClientRect();
  const mx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  let best = 0;
  chart.pts.forEach((p, i) => { if (Math.abs(p.x - mx) < Math.abs(chart.pts[best].x - mx)) best = i; });
  drawChart(best);
}

// 1200x630 image for sharing (fits X, WhatsApp, Instagram stories crop).
async function shareCard() {
  const ch = S.chap;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const C = { bg: v("--bg"), text: v("--text"), sub: v("--sub"), main: v("--main") };
  await Promise.all([
    document.fonts.load('600 64px "Literata"'), document.fonts.load('400 30px "Literata"'),
    document.fonts.load('400 40px "Lexend Deca"'), document.fonts.load('400 76px "Roboto Mono"'),
  ]).catch(() => {});
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 630;
  const g = c.getContext("2d");
  const serif = '"Literata", Georgia, serif', mono = '"Roboto Mono", Menlo, monospace', ui = '"Lexend Deca", sans-serif';
  const fit = (s, w) => { while (g.measureText(s).width > w && s.length > 4) s = s.slice(0, -2).trimEnd() + "…"; return s.replace(/…+$/, "…"); };

  g.fillStyle = C.bg; g.fillRect(0, 0, 1200, 630);
  g.font = `400 44px ${ui}`; g.textBaseline = "alphabetic";
  g.fillStyle = C.text; g.fillText("book", 80, 110);
  g.fillStyle = C.main; g.fillText("type", 80 + g.measureText("book").width, 110);
  const host = /^(localhost|127\.)/.test(location.hostname) || !location.hostname ? "" : location.hostname;
  if (host) { g.font = `400 24px ${mono}`; g.fillStyle = C.sub; g.textAlign = "right"; g.fillText(host, 1120, 108); g.textAlign = "left"; }

  g.font = `400 32px ${serif}`; g.fillStyle = C.sub;
  g.fillText("I typed", 80, 215);
  g.font = `600 60px ${serif}`; g.fillStyle = C.text;
  g.fillText(fit(ch.title, 1040), 80, 290);
  g.font = `400 34px ${serif}`; g.fillStyle = C.sub;
  g.fillText(fit("of " + S.book.title + (S.book.author ? " by " + S.book.author : ""), 1040), 80, 345);

  let x = 80;
  for (const [val, label] of [[wpm(ch.chars, ch.ms), "wpm"], [acc(ch.correct, ch.keys) + "%", "accuracy"], [fmtTime(ch.ms), "time"]]) {
    g.font = `400 76px ${mono}`; g.fillStyle = C.main;
    g.fillText(String(val), x, 470);
    const w = g.measureText(String(val)).width;
    g.font = `400 26px ${mono}`; g.fillStyle = C.sub;
    g.fillText(label, x, 512);
    x += Math.max(w, g.measureText(label).width) + 80;
  }

  const d = ch.paras;
  if (d.length >= 2) {
    const hi = Math.max(...d), lo = Math.min(...d), span = Math.max(hi - lo, 10);
    const x0 = 80, x1 = 1120, y0 = 545, y1 = 590;
    g.strokeStyle = C.main; g.globalAlpha = 0.85; g.lineWidth = 3; g.lineJoin = g.lineCap = "round";
    g.beginPath();
    d.forEach((val, i) => {
      const px = x0 + (i * (x1 - x0)) / (d.length - 1), py = y1 - ((val - lo) / span) * (y1 - y0);
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    });
    g.stroke(); g.globalAlpha = 1;
  }

  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], "booktype-chapter.png", { type: "image/png" });
  const text = `I typed ${ch.title} of ${S.book.title} at ${wpm(ch.chars, ch.ms)} wpm on booktype`;
  track("share");
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Image saved. Post it anywhere.");
}

// ---------- input ----------

const input = $("#input");

function focusInput() {
  if ($("#reader").hidden) return;
  input.focus({ preventScroll: true });
}

input.addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertCompositionText") return; // IME: wait for compositionend
  e.preventDefault();
  if ($("#reader").hidden) return;
  switch (e.inputType) {
    case "insertText":
      for (const ch of e.data || "") typeChar(ch);
      break;
    // insertReplacementText (autocorrect, smart quotes) is ignored: it rewrites a whole word
    case "insertLineBreak":
    case "insertParagraph":
      typeChar("\n");
      break;
    case "deleteContentBackward":
      backspace(false);
      break;
    case "deleteWordBackward":
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      backspace(true);
      break;
  }
});

input.addEventListener("compositionend", (e) => {
  for (const ch of e.data || "") typeChar(ch);
  input.value = "";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Tab") { e.preventDefault(); skipParagraph(); }
  if (e.key === "Escape") { e.preventDefault(); if (!closeSettings()) showBook(S.book.id); }
});

input.addEventListener("focus", () => $("#reader").classList.remove("unfocused"));
// leaving the text (tap elsewhere, click a setting) brings the hidden UI back; phones have no mousemove
input.addEventListener("blur", () => { $("#reader").classList.add("unfocused"); document.body.classList.remove("focus"); });

document.addEventListener("keydown", (e) => {
  // defaultPrevented: the input already handled this key (its handler may have switched screens since)
  if (e.defaultPrevented || document.activeElement === input || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === "SELECT") return;
  if (!$("#results").hidden) {
    if (e.key === "Enter" && e.target.id !== "r-share") { e.preventDefault(); continueFromResults(); }
    if (e.key === "Escape") showBook(S.book.id);
    return;
  }
  if (!$("#bookview").hidden) {
    if (e.key === "Escape") showLibrary();
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") $("#bv-go").click();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus([$("#bv-go"), ...document.querySelectorAll("#bv-chapters button")], e.key === "ArrowDown" ? 1 : -1);
    }
    return;
  }
  if (!$("#library").hidden && e.key.startsWith("Arrow")) {
    e.preventDefault();
    const cards = [...document.querySelectorAll("#grid .card")];
    const cols = getComputedStyle($("#grid")).gridTemplateColumns.split(" ").length;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    moveFocus(cards, step);
    return;
  }
  if (!$("#reader").hidden) {
    if (e.key === "Escape" && closeSettings()) return focusInput();
    // input wasn't focused (e.g. after clicking a setting): focus it and keep this keystroke
    focusInput();
    if (e.key.length === 1 || e.key === "Enter") {
      e.preventDefault();
      typeChar(e.key === "Enter" ? "\n" : e.key);
    } else if (e.key === "Tab") {
      e.preventDefault();
      skipParagraph();
    }
  }
});

// arrow-key navigation over a list of buttons
function moveFocus(items, step) {
  const i = items.indexOf(document.activeElement);
  const next = items[i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + step))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

$("#text").addEventListener("click", focusInput);
$("#skip").addEventListener("click", () => { skipParagraph(); focusInput(); });
$("#nav-library").addEventListener("click", showLibrary);
// moving the mouse brings the hidden UI back (focus mode). Laptop trackpads twitch while you type,
// so it takes a deliberate move (40px within half a second), not a brush of the palm.
let mouseAt = null, moved = 0, movedAt = 0;
document.addEventListener("mousemove", (e) => {
  const now = performance.now();
  if (now - movedAt > 500) moved = 0;
  if (mouseAt) moved += Math.abs(e.clientX - mouseAt[0]) + Math.abs(e.clientY - mouseAt[1]);
  mouseAt = [e.clientX, e.clientY];
  movedAt = now;
  if (moved > 40) document.body.classList.remove("focus");
});
$("#blurred").addEventListener("click", focusInput);
$("#logo").addEventListener("click", showLibrary);
$("#done-back").addEventListener("click", showLibrary);
$("#r-next").addEventListener("click", continueFromResults);
$("#r-share").addEventListener("click", () => shareCard().catch((e) => toast(e.message, 5000)));
$("#r-canvas").addEventListener("mousemove", chartHover);
$("#r-canvas").addEventListener("touchstart", chartHover, { passive: true });
$("#r-canvas").addEventListener("mouseleave", () => drawChart(-1));

$("#cr-logo").addEventListener("click", showLibrary);
$("#cr-lib").addEventListener("click", showLibrary);
$("#cr-book").addEventListener("click", () => showBook(S.book.id));

$("#file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) openFile(f).catch((err) => toast(err.message, 6000));
});

window.addEventListener("resize", () => {
  moveCaret(true);
  if (!$("#results").hidden) drawChart(-1);
});
window.addEventListener("beforeunload", () => { savePos(); saveChap(); });
document.fonts?.ready.then(() => moveCaret(true));

// ---------- options ----------

function renderOptions() {
  const values = { strict: String(S.strict), goal: String(S.goal), font: S.font, view: S.view, size: S.size };
  for (const g of document.querySelectorAll("#settings [data-opt]")) {
    for (const b of g.querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === values[g.dataset.opt]);
  }
  document.body.classList.toggle("serif", S.font === "book");
  document.body.classList.toggle("view-page", S.view === "page");
  document.body.classList.toggle("view-focus", S.view === "focus");
  for (const z of ["s", "l"]) document.body.classList.toggle("size-" + z, S.size === z);
  document.documentElement.dataset.theme = S.theme;
  $("#theme-name").textContent = S.theme.replace("-", " ");
}

$("#settings").addEventListener("click", (e) => {
  const b = e.target.closest("[data-opt] button");
  if (!b) return;
  const opt = b.parentElement.dataset.opt, v = b.dataset.v;
  if (opt === "strict") S.strict = v === "true";
  if (opt === "goal") S.goal = +v;
  if (opt === "font") S.font = v;
  if (opt === "view") S.view = v;
  if (opt === "size") S.size = v;
  store.set(opt, S[opt]);
  renderOptions();
  if (S.book && !$("#reader").hidden) {
    $("#text").scrollTop = 0;
    moveCaret(true);
    updateStats();
  }
  focusInput();
});

// settings popover (wrong key / goal / font): you set these once, so they stay out of the way
function closeSettings() {
  if ($("#settings").hidden) return false;
  $("#settings").hidden = true;
  $("#gear").setAttribute("aria-expanded", "false");
  return true;
}
$("#gear").addEventListener("click", () => {
  if (closeSettings()) return focusInput();
  $("#settings").hidden = false;
  $("#gear").setAttribute("aria-expanded", "true");
  focusInput(); // keep typing ready; the first key closes the panel
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#settings, #gear")) closeSettings();
});

$("#theme-btn").addEventListener("click", () => {
  S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length];
  store.set("theme", S.theme);
  renderOptions();
  if (!$("#results").hidden) drawChart(-1);
  focusInput();
});

// ---------- start ----------

renderOptions();
const lastBook = store.get("last");
if (lastBook) openBook(lastBook).catch(showLibrary);
else {
  // first visit: drop straight into a short book, like monkeytype drops you into a test
  $("#hint").hidden = false;
  openBook(FIRST_BOOK).catch(showLibrary);
}
