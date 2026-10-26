# booktype: context log

Read a book by typing it (monkeytype-style). Static site, no backend.

## Run
`python3 -m http.server 8000` in this folder, open http://localhost:8000.
(Opening index.html directly also works; books load as `<script>` files.)

## Files
- `index.html`, `style.css`: page + theme (dark default, light via OS setting)
- `parse.js`: text/EPUB -> paragraphs + chapters. Shared by bundled and uploaded books.
- `app.js`: typing engine, pages, progress, library
- `build_books.py`: raw/<gutenberg id>.txt -> books/<slug>.js (raw/ is gitignored)
- `books/`: 5 public-domain books (Project Gutenberg)

## How the engine works (borrowed design from monkeytype, no code copied)
- Hidden `<textarea>` gets `beforeinput` events -> works with phone keyboards and IME.
- Every letter is a `<span>`; words are `nowrap` spans so lines break only at spaces.
- Caret is one absolutely-positioned div moved with `transform` (smooth glide).
- WPM = correct chars / 5 / active minutes. Pauses > 4 s don't count (reading time).
- Page ≈ 650 chars; chapters always start a new page. Paragraph end = Enter or Space.
- Accents fold (é accepts e); symbols not on a keyboard (£, ½) accept any key.
- Progress saved per book in localStorage (`bt:progress:<id>`), resumes at word start.
- Uploaded .txt/.epub parsed in browser, saved to localStorage (`bt:book:<id>`).

## Monkeytype analysis (2026-10-23)
- Tool: REA (`npm i -g rea-agents`, v6.7.0, github.com/morluto/rea). Ran
  `rea analyze-web-bundle` against headless Brave on monkeytype.com.
- Found: 92 routes (API: /results, /leaderboards, /quotes, /users/...), Firebase auth,
  Chart.js, TanStack. Main app source map not public.
- Monkeytype is open source (GPL-3.0): github.com/monkeytypegame/monkeytype.
  Read `frontend/src/ts/input/*`, `test/poetry.ts`, `test/wikipedia.ts`, `utils/numbers.ts`.
  Its "poetry"/"wikipedia" modes already pull outside text; no book mode.
- GPL: copying their code makes this site GPL too. Ideas/design are fine.

## Legal
- 1984 (Orwell) is still under copyright in the US until 2044. Don't bundle it.
  Readers can open their own copy via "Open your own .txt or .epub".
- Existing competitor: typelit.io (types classic books). Differentiate.

## State
- [x] v0 (2026-10-23): library, 5 books, typing, chapters, resume, EPUB/TXT upload, mobile
- [x] v1 (2026-10-24), all tested headless:
  - space mid-word skips rest of word (marked missed)
  - daily page goal (1/3/5/10, button in hints) + day streak; goal-done toast
  - chapter results screen: wpm/acc/time/chars/streak tiles, wpm-per-paragraph chart
    with hover, 5 slowest words, "Share image" (1200x630 PNG, native share or download)
  - analytics hooks: track() events open/page/goal/chapter/share/upload -> GoatCounter
    once GOATCOUNTER_CODE is set at top of app.js (empty = off)
- [x] Own git repo (home folder is also a git repo: never commit from there). 1 commit on main.
- [x] LIVE 2026-10-24: https://codercraft.me/booktype/ (repo github.com/iSuthar/booktype, Pages from main /)
  - codercraft.me = custom domain of iSuthar.github.io. HTTPS cert issued 2026-10-24 (expires
    2027-01-22, GitHub auto-renews); Enforce HTTPS on for both repos.
- [x] GoatCounter on: dashboard https://isuthar.goatcounter.com/ (pageviews + events: open/page/goal/chapter/share/upload)
- [ ] Get 5 strangers to type a page
- [x] v2 (2026-10-25): monkeytype-style redesign
  - layout: logo + nav (library, streak), config pill bar (book/chapter, mistakes, goal, font),
    live stats, 4-line text box, footer key hints + theme switcher
  - themes: serika dark (default), serika, nord, dracula, paper, matrix (THEMES in app.js, vars in style.css)
  - fonts: Lexend Deca UI, Roboto Mono typing (serif = Literata option)
  - typing: focus mode (UI fades while typing, mouse brings back), caret locked to line 2 with
    whole-line scrolling, red underline on words with mistakes, live wpm hidden for first 2 s,
    keys pressed while input unfocused are still typed, autocorrect replacements ignored
  - fixed Tab "letters scatter": char class `done` collided with the `.done` screen CSS -> renamed `read`
  - results screen restyled (big wpm/acc + chart, small stats row)
- [x] v2.1 (2026-10-26), from a first-visit UX review:
  - first visit (no `bt:last`) opens Alice ch.1 straight away with a "just start typing" hint (FIRST_BOOK in app.js)
  - book % counts from chapter 1 (front matter excluded): pctAt() in app.js
  - chapter names normalised by chapterTitle() in parse.js ("CHAPTER XIII" -> "Chapter 13", caps titles -> Title Case)
  - text box 5 lines on desktop; on a page's first text line the box doesn't scroll, so headings stay visible
  - wrong-key / goal / font moved into a settings popover (sliders icon); bar keeps book + chapter only
  - input blur ends focus mode (phones have no mousemove to bring the UI back)
  - Review ideas not done yet: hide "0/3 pages today" before first page, upload card last, card length
    as "N chapters · ~h", "page x/y" in chapter, fewer/dimmer live stats, no tab/esc hints on phones,
    check phone keyboard covering the text on a real phone
- [x] v3 (2026-10-26): book feel, after a typelit.io review (ideas only, no code/assets copied)
  - "book page" layout is the default: whole page, Literata serif, ~38em column, paragraph gaps,
    printed-style chapter heading; window scrolls to keep the caret in the top third. "focus" = old 5-line view
    (settings > layout). S.view / bt:view; body.view-page / body.view-focus.
  - fixed pagination: parse.js buildPage/paginate (PAGE_CHARS 1100, from startP); book.pages, pageOf(),
    chapter.page / chapter.pages -> "page 3 of 8" in the reader, resume loads the page that holds the position
  - reader top bar: logo / library / book / chapter crumbs + page x of y, wpm, acc, today's pages, settings gear
  - book page (#bookview): generated cloth-colour cover, chapters done, page x of y, % read, continue button,
    chapter list with page counts, ticks and current chapter. library card -> book page; Esc: reader -> book -> library
  - library cards: small cover + "N pages · M chapters" (build_index.js adds counts to books/index.js,
    run by build_books.py); upload card moved last; "pages today" hidden until there is something to show
  - typelit notes: hosts 1984 (we don't, US copyright), import needs account + subscription, text overflows on phones
- [x] v3.1 (2026-10-26) laptop pass (tested 1280x720, 1366x768, 1536x864); site is mainly used on laptops
  - reader top bar is sticky (stats stay visible while the page scrolls)
  - page view scrolls line by line once the caret passes 40% of the screen, so the typing line stays at eye level
  - focus mode needs a deliberate mouse move (40px in 0.5 s) to bring the UI back: trackpad twitches don't
  - keyboard: library opens with the last book focused, arrow keys move between cards, Enter opens;
    book page: Enter continue, up/down through chapters, Esc library. Footer hints change per screen
  - settings: text size small/medium/large (body.size-s / size-l); key help row
  - small covers show a big initial (titles were breaking mid-word)
- Test note: when driving the page in tests, type from S.k (resume point), not from chars[0].
- Ideas parked: ghost caret of your past pace, focus mode, more books (Gatsby, Dracula,
  Metamorphosis, Dorian Gray, Jekyll & Hyde, Little Women, Art of War, Winnie-the-Pooh),
  instant start for new visitors, themes, IndexedDB for big uploads
