# paper-resize

Re-paper a PDF between A4, Letter and friends **without shrinking it** — a static page that runs
entirely in the browser.

The premise: A4 is 49.89 pt (17.6 mm) taller than Letter, so "convert A4 to Letter" is usually
answered by scaling the whole document to ~94%. That answer is almost always wrong. A typical A4
document leaves far more than 17.6 mm in its top and bottom margins, so the correct output is a
**pure translation at exactly 100%** — the ink simply moves, nothing changes size. Scaling is a last
resort, reached only when the ink genuinely does not fit, and then by the largest factor that works
rather than a blanket fit-to-page.

The tool tells you which case each page is, and shows you.

## How it decides

Ink extents are found by **rasterising each page and scanning pixels**, not by analysing the content
stream.

The content stream describes intent, not result, and the difference is where naive resizers break:

| The content stream says | What actually prints | Vector bbox (e.g. Ghostscript `-sDEVICE=bbox`) | Pixel scan |
|---|---|---|---|
| full-page white rectangle | nothing | ink covers the whole sheet | correct |
| invisible OCR text layer (`3 Tr`) | nothing | ink covers the whole sheet | correct |
| content outside the CropBox | nothing | counted | correct |
| `/Rotate 90` | landscape | needs separate handling | handled by the renderer |

At 144 dpi the quantisation error is 0.5 pt, against the ~50 pt of headroom being measured, and the
box is grown by one pixel per side so the error can only ever be conservative.

## What it preserves

The page is rewritten **in place** rather than copied into a new document: the existing content
stream becomes a Form XObject, and the page's new content is just `q <matrix> cm /X0 Do Q`.
Everything else in the file — structure tree, metadata, embedded files, fonts, AcroForm — is never
touched, so it survives by construction.

Geometry that lives outside the content stream is pushed through the same matrix:

- annotation `/Rect`, `/QuadPoints`, `/Vertices`, `/L`, `/CL`, `/InkList`, `/RD`, border widths
- bookmark and link destinations: `/XYZ`, `/FitH`, `/FitBH`, `/FitV`, `/FitBV`, `/FitR`, in the
  outline tree, the `/Names /Dests` name tree, the legacy `/Dests` dictionary and `/OpenAction`
- `/BleedBox`, `/TrimBox`, `/ArtBox`, clamped to the new media box

Wrapping in a Form XObject is also the robust answer to **unbalanced `q`/`Q`**, which is common in
real files: prefixing such a stream with `cm` lets a stray `Q` pop the transform off the stack
partway down the page. Inside a form, the graphics state cannot escape.

## Edge cases covered

Each has a fixture in `test/fixtures` and assertions in `test/run.mjs`.

- generous margins → exactly 100%, verified by measuring source and output ink
- ink that genuinely overflows → smallest sufficient scale, still fully on the page
- full-page white rectangle → not fooled
- invisible OCR text layer → not fooled
- `/Rotate` 90/180/270 → baked into the matrix, output has `/Rotate 0`
- unbalanced `q`/`Q` → content moves as one block
- `/Contents` as an array split at a token boundary → separator inserted
- mixed page sizes and orientations in one file → each fitted on its own
- blank pages → excluded from the document-wide scale instead of dragging it to 94%
- pages already the target size → skipped entirely, bytes untouched
- CropBox smaller than MediaBox → fitted from the CropBox, hidden content stays hidden
- inherited `/Resources` and `/Rotate` from the page tree
- full-bleed backgrounds → detected, with fit (white border) or fill (crop) modes
- AcroForm fields → widget, value and appearance stream all survive
- transparency groups → moved onto the form so blend modes render the same
- shared content streams → one form built per distinct stream, not per page

## Known limitations

Stated plainly, because the point of the tool is honesty about what it did:

- **Encrypted PDFs are refused.** pdf-lib cannot decrypt content streams, and processing them with
  `ignoreEncryption` would emit a corrupt file. Remove the password first.
- **Digital signatures are invalidated.** Unavoidable — any modification does that. The tool detects
  and warns rather than silently breaking them.
- **Tagged PDFs can degrade.** `/StructParents` is copied onto the form, which works in practice,
  but reading order in strict screen readers may suffer.
- **`/FitH` on a rotated page is approximate.** A horizontal fit conceptually becomes a vertical one
  under a 90° rotation; the coordinate is transformed, the destination type is not.
- **Large files are limited by tab memory**, especially on iOS Safari.
- **"Perfect" is not achievable at the PDF level.** If ink occupies the extra 17.6 mm, something has
  to give. Only re-laying-out the source document can avoid that, and a PDF-level tool has no
  access to the source.
- **The printer gets the last word.** Most printers cannot print within a few millimetres of the
  paper edge, and drivers often apply their own fit-to-printable-area scaling. Print at *Actual
  size* / *100%*, and use the safety inset if your printer clips.

## Deploying to GitHub Pages

The whole thing is static with no build step — the site *is* the repository. `pdf.js` and `pdf-lib`
are vendored under `vendor/`, so there are no CDN or network calls.

`.github/workflows/pages.yml` publishes on every push to `main`. To use it, set
**Settings → Pages → Source** to *GitHub Actions*. (The alternative, *Deploy from a branch* →
`main` → `/ (root)`, works equally well; `.nojekyll` is present so Jekyll does not eat any
underscore-prefixed paths.)

`.github/workflows/test.yml` runs the full suite on every push and pull request.

Two things worth knowing:

- **The pdf.js worker must be same-origin.** That is why it is vendored rather than loaded from a
  CDN — it also means the page works offline once loaded.
- **Do not publish from the root of a private repository** unless you have checked what else is in
  it. Pages serves whatever directory you point it at.

`SharedArrayBuffer` is unavailable because Pages cannot set COOP/COEP headers, which rules out
multi-threaded WebAssembly builds of Ghostscript or MuPDF. Not needed here.

## Development

```bash
npm install
npm test          # builds fixtures, then drives the real page in Chromium
npm run serve     # http://localhost:8080
```

The suite is end-to-end on purpose: the measurement only exists inside a canvas, so there is nothing
meaningful to unit-test in isolation. It converts each fixture through the actual UI, then re-opens
the produced PDF and checks the geometry — including re-rasterising the output and comparing ink
dimensions against the source, which is the only real test of "100%".

If Playwright's bundled Chromium is not installed, point at an existing one:

```bash
CHROMIUM_PATH=/path/to/chrome npm test
```

## Layout

```
index.html      UI
styles.css
src/matrix.js   2D affine helpers in PDF's [a b c d e f] convention
src/paper.js    paper sizes, tolerant size recognition
src/measure.js  ink extents by rasterising and scanning pixels
src/plan.js     per-page fit decision, anchoring, document-wide scale
src/rewrite.js  PDF surgery: Form XObject wrap, annotation and destination remapping
src/app.js      wiring and previews
vendor/         pdf.js 5.4.149, pdf-lib 1.17.1
```
