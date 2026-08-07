/**
 * End-to-end suite. Drives the real page in a real browser — the pixel-scan
 * measurement only exists inside a canvas, so there is nothing meaningful to
 * unit-test in isolation — then re-opens every produced PDF and checks the
 * geometry that came out.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFArray, PDFNumber, PDFDict, PDFRef } from 'pdf-lib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'output');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf',
};

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- static server

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(req.url.split('?')[0]);
        const file = join(ROOT, path === '/' ? 'index.html' : path);
        if (!file.startsWith(ROOT)) throw new Error('escape');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------- browser run

async function convert(page, fixture, options = {}) {
  await page.goto(`${page.__base}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => { window.__paperResize = null; });

  await page.setInputFiles('#file', join(HERE, 'fixtures', fixture));
  await page.waitForFunction(() => window.__paperResize?.plan?.length > 0, null, { timeout: 60000 });

  if (Object.keys(options).length) {
    await page.evaluate((opts) => {
      for (const [id, value] of Object.entries(opts)) {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = value;
        else el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, options);
    await page.waitForTimeout(300);
  }

  const plan = await page.evaluate(() => window.__paperResize.plan);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#build'),
  ]);
  const path = join(OUT, `${fixture.replace(/\.pdf$/, '')}-out.pdf`);
  await download.saveAs(path);

  const status = await page.textContent('#status');
  return { plan, path, bytes: await readFile(path), status };
}

// ---------------------------------------------------------------- pdf helpers

const N = PDFName.of.bind(PDFName);

async function open(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

function pageSize(doc, i) {
  const box = doc.getPage(i).getMediaBox();
  return [box.width, box.height];
}

function contentOf(doc, i) {
  const ctx = doc.context;
  const stream = ctx.lookup(doc.getPage(i).node.get(N('Contents')));
  return new TextDecoder().decode(stream.contents ?? stream.getContents());
}

function annotRects(doc, i) {
  const ctx = doc.context;
  const annots = ctx.lookupMaybe(doc.getPage(i).node.get(N('Annots')), PDFArray);
  if (!annots) return [];
  return annots.asArray().map((entry) => {
    const rect = ctx.lookupMaybe(ctx.lookupMaybe(entry, PDFDict).get(N('Rect')), PDFArray);
    return rect.asArray().map((v) => ctx.lookup(v).asNumber());
  });
}

/**
 * Rasterise a page and return the ink box in points, to verify the output.
 * Runs on a dedicated probe page: the page under test is navigated on every
 * conversion, which would wipe any helper installed on it.
 */
async function inkBoxOf(probe, bytes, index) {
  const b64 = Buffer.from(bytes).toString('base64');
  return probe.evaluate(async ([data, i]) => {
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const doc = await window.__pdfjs.getDocument({ data: bin }).promise;
    const p = await doc.getPage(i + 1);
    const viewport = p.getViewport({ scale: 2, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const k = (y * canvas.width + x) * 4;
        if (px[k] < 245 || px[k + 1] < 245 || px[k + 2] < 245) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const a = viewport.convertToPdfPoint(x0, y1);
    const b = viewport.convertToPdfPoint(x1, y0);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }, [b64, index]);
}

// --------------------------------------------------------------------- tests

const LETTER = [612, 792];

async function main() {
  await mkdir(OUT, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage();
  page.__base = `http://127.0.0.1:${port}`;

  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [browser error] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`    [page error] ${e.message}`));

  // A dedicated page holding a pdf.js handle for the verification helper.
  const probe = await browser.newPage();
  await probe.goto(`${page.__base}/index.html`);
  await probe.evaluate(async (base) => {
    window.__pdfjs = await import(`${base}/vendor/pdf.min.mjs`);
    window.__pdfjs.GlobalWorkerOptions.workerSrc = `${base}/vendor/pdf.worker.min.mjs`;
  }, page.__base);

  // ---- 1. the common case must not scale at all
  console.log('\nnormal A4 — generous margins');
  {
    const { plan, bytes } = await convert(page, 'normal-a4.pdf');
    check('every page at exactly 100%', plan.every((p) => p.scale === 1),
      `scales: ${plan.map((p) => p.scale).join(', ')}`);
    check('all pages translated, none skipped', plan.every((p) => p.action === 'translate'));
    const doc = await open(bytes);
    check('output is Letter', near(pageSize(doc, 0)[0], 612) && near(pageSize(doc, 0)[1], 792),
      pageSize(doc, 0).join('x'));

    // The real test of "100%": measure the ink in the source and in the output.
    const src = await inkBoxOf(probe, await readFile(join(HERE, 'fixtures', 'normal-a4.pdf')), 0);
    const out = await inkBoxOf(probe, bytes, 0);
    check('ink width unchanged', near(src[2] - src[0], out[2] - out[0], 1.5),
      `${(src[2] - src[0]).toFixed(2)} vs ${(out[2] - out[0]).toFixed(2)}`);
    check('ink height unchanged', near(src[3] - src[1], out[3] - out[1], 1.5),
      `${(src[3] - src[1]).toFixed(2)} vs ${(out[3] - out[1]).toFixed(2)}`);
  }

  // ---- 2. genuine overflow must scale, and by the minimum
  console.log('\ntight A4 — ink really overflows');
  {
    const { plan, bytes } = await convert(page, 'tight-a4.pdf');
    check('scaled below 100%', plan[0].scale < 1, `scale ${plan[0].scale}`);
    check('scaled by less than 6%', plan[0].scale > 0.94, `scale ${plan[0].scale}`);
    const out = await inkBoxOf(probe, bytes, 0);
    check('ink fits inside Letter', out[3] - out[1] <= 792 + 1 && out[2] - out[0] <= 612 + 1,
      `${(out[2] - out[0]).toFixed(1)}x${(out[3] - out[1]).toFixed(1)}`);
    check('ink is inside the page box', out[0] >= -1 && out[1] >= -1 && out[2] <= 613 && out[3] <= 793);
  }

  // ---- 3. the white-rectangle trap
  console.log('\nwhite rectangle covering the page');
  {
    const { plan } = await convert(page, 'white-rect-a4.pdf');
    check('not fooled into scaling', plan[0].scale === 1, `scale ${plan[0].scale}`);
    check('not flagged as full bleed', plan[0].isFullBleed === false);
  }

  // ---- 4. the invisible OCR layer trap
  console.log('\ninvisible OCR text layer');
  {
    const { plan } = await convert(page, 'ocr-layer-a4.pdf');
    check('not fooled into scaling', plan[0].scale === 1, `scale ${plan[0].scale}`);
    check('ink box excludes the invisible lines', plan[0].inkDisplay[3] < 800,
      `top of ink at ${plan[0].inkDisplay[3].toFixed(1)}`);
  }

  // ---- 5. /Rotate 90
  console.log('\n/Rotate 90');
  {
    const { plan, bytes } = await convert(page, 'rotated-a4.pdf');
    check('treated as landscape', plan[0].sourceDisplay.w > plan[0].sourceDisplay.h,
      `${plan[0].sourceDisplay.w}x${plan[0].sourceDisplay.h}`);
    const doc = await open(bytes);
    check('output is landscape Letter', near(pageSize(doc, 0)[0], 792) && near(pageSize(doc, 0)[1], 612),
      pageSize(doc, 0).join('x'));
    const rotate = doc.context.lookup(doc.getPage(0).node.get(N('Rotate')));
    check('/Rotate zeroed', rotate instanceof PDFNumber && rotate.asNumber() === 0);
    const src = await inkBoxOf(probe, await readFile(join(HERE, 'fixtures', 'rotated-a4.pdf')), 0);
    const out = await inkBoxOf(probe, bytes, 0);
    // Source measured unrotated (tall), output is rotated into landscape.
    check('ink preserved at 100% through the rotation',
      near(src[3] - src[1], out[2] - out[0], 2),
      `${(src[3] - src[1]).toFixed(1)} vs ${(out[2] - out[0]).toFixed(1)}`);
  }

  // ---- 6. unbalanced q/Q
  console.log('\nunbalanced q/Q in the content stream');
  {
    const { bytes } = await convert(page, 'unbalanced-q.pdf');
    const doc = await open(bytes);
    check('page content is the wrapper only', /^q\s+[-\d. ]+cm\s+\/X0 Do\s+Q\s*$/.test(contentOf(doc, 0)),
      JSON.stringify(contentOf(doc, 0)));
    const out = await inkBoxOf(probe, bytes, 0);
    // Both lines must have moved together. If the stray Q had escaped, the
    // second line would sit at its original coordinates.
    check('all content shifted as one block', out[1] > 25 && out[3] < 770,
      `ink y ${out[1].toFixed(1)}..${out[3].toFixed(1)}`);
  }

  // ---- 7. /Contents split mid-token
  console.log('\n/Contents array split mid-token');
  {
    const { bytes } = await convert(page, 'split-contents.pdf');
    const out = await inkBoxOf(probe, bytes, 0);
    check('text landed on the page', out !== null && out[3] > 400 && out[3] < 792,
      out ? `ink top at ${out[3].toFixed(1)}` : 'no ink at all');
  }

  // ---- 8. mixed page sizes
  console.log('\nmixed page sizes');
  {
    const { plan, bytes } = await convert(page, 'mixed-sizes.pdf');
    const doc = await open(bytes);
    check('portrait A4 becomes portrait Letter', near(pageSize(doc, 0)[0], 612) && near(pageSize(doc, 0)[1], 792));
    check('A5 becomes portrait Letter', near(pageSize(doc, 1)[0], 612) && near(pageSize(doc, 1)[1], 792));
    check('landscape A4 becomes landscape Letter', near(pageSize(doc, 2)[0], 792) && near(pageSize(doc, 2)[1], 612));
    check('nothing scaled', plan.every((p) => p.scale === 1), plan.map((p) => p.scale).join(', '));
  }

  // ---- 9. blank page and an already-correct page
  console.log('\nblank page + already-Letter page');
  {
    const { plan, bytes } = await convert(page, 'blank-and-letter.pdf');
    check('blank page detected', plan[0].blank === true);
    check('blank page does not drag the document scale down', plan[0].scale === 1 && plan[1].scale === 1);
    check('already-Letter page skipped entirely', plan[1].action === 'skip', plan[1].action);
    const doc = await open(bytes);
    check('blank page resized to Letter', near(pageSize(doc, 0)[0], 612) && near(pageSize(doc, 0)[1], 792));
    check('skipped page left untouched', !contentOf(doc, 1).includes('/X0 Do'));
  }

  // ---- 10. annotations, destinations and the CropBox
  console.log('\nannotations, destinations, CropBox');
  {
    const srcDoc = await open(await readFile(join(HERE, 'fixtures', 'annots-and-dests.pdf')));
    const srcRect = annotRects(srcDoc, 0)[0];

    const { plan, bytes } = await convert(page, 'annots-and-dests.pdf');
    const doc = await open(bytes);

    const outRect = annotRects(doc, 0)[0];
    check('link annotation survived', outRect !== undefined);
    check('link rect moved with the content',
      outRect && !near(outRect[1], srcRect[1], 0.5) && near(outRect[2] - outRect[0], srcRect[2] - srcRect[0], 0.5),
      outRect ? `${srcRect.map(v=>v.toFixed(1))} -> ${outRect.map(v=>v.toFixed(1))}` : 'missing');

    // The link sits 80 pt below the header in the source; check it still does.
    const ctx = doc.context;
    const outline = ctx.lookupMaybe(ctx.lookupMaybe(doc.catalog.get(N('Outlines')), PDFDict).get(N('First')), PDFDict);
    const dest = ctx.lookupMaybe(outline.get(N('Dest')), PDFArray);
    const destY = ctx.lookup(dest.get(3)).asNumber();
    check('outline destination remapped', !near(destY, 520, 0.5), `y = ${destY.toFixed(1)}`);

    const linkDest = ctx.lookupMaybe(
      ctx.lookupMaybe(ctx.lookupMaybe(doc.getPage(0).node.get(N('Annots')), PDFArray).get(0), PDFDict).get(N('Dest')),
      PDFArray);
    check('link destination remapped to the same place',
      near(ctx.lookup(linkDest.get(3)).asNumber(), destY, 0.01),
      `${ctx.lookup(linkDest.get(3)).asNumber().toFixed(1)} vs ${destY.toFixed(1)}`);

    const out = await inkBoxOf(probe, bytes, 0);
    // Visible content spans ~672 pt. If the CropBox-hidden line had come back
    // the ink would be ~100 pt taller; the placement offset is irrelevant.
    check('CropBox-hidden content stayed hidden', out[3] - out[1] < 700,
      `ink is ${(out[3] - out[1]).toFixed(1)} pt tall, expected ~672`);
    check('page 1 fitted from the CropBox, not the MediaBox', plan[0].scale === 1);
  }

  // ---- 11. full bleed
  console.log('\nfull-bleed background');
  {
    const { plan } = await convert(page, 'full-bleed-a4.pdf');
    check('detected as full bleed', plan[0].isFullBleed === true);
    check('fit mode scales to fit', plan[0].scale < 1 && near(plan[0].scale, 792 / 841.89, 0.01),
      `scale ${plan[0].scale}`);

    const filled = await convert(page, 'full-bleed-a4.pdf', { fullBleed: 'fill' });
    check('fill mode scales up to cover', filled.plan[0].scale > 1,
      `scale ${filled.plan[0].scale}`);
  }

  // ---- 12. AcroForm field survives with its value and appearance
  console.log('\nAcroForm text field');
  {
    const { bytes } = await convert(page, 'form-field-a4.pdf');
    const doc = await open(bytes);
    const form = doc.getForm();
    const field = form.getFields().find((f) => f.getName() === 'applicant.name');
    check('field still in the AcroForm', field !== undefined,
      `fields: ${form.getFields().map((f) => f.getName()).join(', ') || 'none'}`);
    check('field value preserved', field && field.getText() === 'Saltfish',
      field ? JSON.stringify(field.getText()) : 'no field');

    const srcRect = annotRects(await open(await readFile(join(HERE, 'fixtures', 'form-field-a4.pdf'))), 0)[0];
    const outRect = annotRects(doc, 0)[0];
    check('widget rect moved but kept its size',
      outRect && near(outRect[2] - outRect[0], srcRect[2] - srcRect[0], 0.5)
        && near(outRect[3] - outRect[1], srcRect[3] - srcRect[1], 0.5)
        && !near(outRect[1], srcRect[1], 0.5),
      outRect ? `${srcRect.map((v) => v.toFixed(1))} -> ${outRect.map((v) => v.toFixed(1))}` : 'missing');

    const ctx = doc.context;
    const widget = ctx.lookupMaybe(ctx.lookupMaybe(doc.getPage(0).node.get(N('Annots')), PDFArray).get(0), PDFDict);
    check('appearance stream still attached', widget.get(N('AP')) !== undefined);

    const out = await inkBoxOf(probe, bytes, 0);
    check('field renders on the output page', out !== null && out[3] - out[1] > 600,
      out ? `ink ${(out[3] - out[1]).toFixed(0)} pt tall` : 'nothing rendered');
  }

  // ---- 13. options behave
  console.log('\noptions');
  {
    const { plan } = await convert(page, 'normal-a4.pdf', { margin: 5 });
    check('safety inset still fits at 100%', plan[0].scale === 1);
    check('safety inset moves content inward', plan[0].placedInk[0] >= 5 * 72 / 25.4 - 0.01,
      `left edge at ${plan[0].placedInk[0].toFixed(2)}`);

    const centred = await convert(page, 'normal-a4.pdf', { anchor: 'center' });
    const gapTop = 792 - centred.plan[0].placedInk[3];
    const gapBottom = centred.plan[0].placedInk[1];
    check('centred mode balances the margins', near(gapTop, gapBottom, 0.01),
      `${gapTop.toFixed(2)} vs ${gapBottom.toFixed(2)}`);

    const a4back = await convert(page, 'blank-and-letter.pdf', { target: 'a4' });
    check('reverse direction works (Letter -> A4)', a4back.plan[1].action !== 'skip');
  }

  await browser.close();
  server.close();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`\x1b[31m${failures} failing\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mall green\x1b[0m');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
