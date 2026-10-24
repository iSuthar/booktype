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
- [ ] Push to GitHub + Pages: blocked on Ankit approving a public repo. Command:
  `gh repo create iSuthar/booktype --public --source . --push` then
  `gh api -X POST repos/iSuthar/booktype/pages -f "source[branch]=main" -f "source[path]=/"`
  -> https://isuthar.github.io/booktype/
- [ ] GoatCounter: Ankit signs up at goatcounter.com, gives site code -> set GOATCOUNTER_CODE
- [ ] Get 5 strangers to type a page
- Ideas parked: ghost caret of your past pace, focus mode, more books (Gatsby, Dracula,
  Metamorphosis, Dorian Gray, Jekyll & Hyde, Little Women, Art of War, Winnie-the-Pooh),
  instant start for new visitors, themes, IndexedDB for big uploads
