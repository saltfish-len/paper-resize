/**
 * Builds one PDF per edge case we claim to handle. Several of them cannot be
 * produced through a normal PDF library API — that is rather the point, since
 * the cases that break naive resizers are exactly the ones a well-behaved
 * producer never emits.
 */
import { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFArray, degrees } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A4 = [595.28, 841.89];
const A5 = [419.53, 595.28];
const LETTER = [612, 792];

const N = PDFName.of.bind(PDFName);

async function base() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

/** Attach a font under a predictable key so raw content streams can use it. */
function withFont(page, font) {
  page.node.setFontDictionary(N('F1'), font.ref);
  return page;
}

function setRawContent(doc, page, ops) {
  page.node.set(N('Contents'), doc.context.register(doc.context.stream(ops)));
}

// Text render mode is part of the graphics state and survives ET, so every run
// states its own — otherwise the OCR fixture's `3 Tr` would silence the rest of
// the page and the fixture would test nothing.
const text = (x, y, size, str) =>
  `BT 0 Tr /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${str}) Tj ET\n`;

async function save(name, doc) {
  const bytes = await doc.save();
  await writeFile(join(OUT, name), bytes);
  console.log(`  ${name.padEnd(26)} ${(bytes.length / 1024).toFixed(1)} KB`);
}

// 1 — the common case: generous margins, must come out at exactly 100%.
async function normalA4() {
  const { doc, font } = await base();
  for (let i = 0; i < 3; i++) {
    const page = withFont(doc.addPage(A4), font);
    setRawContent(doc, page,
      text(72, 780, 14, `Page ${i + 1} header`) +
      text(72, 420, 11, 'Body text in the middle of the page.') +
      text(72, 60, 9, `- ${i + 1} -`));
  }
  await save('normal-a4.pdf', doc);
}

// 2 — ink really does overflow, so a scale is unavoidable.
async function tightA4() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    text(40, 830, 10, 'Header only 12 mm from the top edge') +
    text(40, 400, 11, 'Body') +
    text(40, 8, 10, 'Footer 8 pt from the bottom edge'));
  await save('tight-a4.pdf', doc);
}

// 3 — /Rotate 90. Content coordinates are unrotated; the display is landscape.
async function rotatedA4() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  page.setRotation(degrees(90));
  setRawContent(doc, page,
    text(72, 780, 14, 'Rotated page') +
    text(72, 60, 10, 'bottom of the unrotated content'));
  await save('rotated-a4.pdf', doc);
}

// 4 — the classic trap: a full-page white rectangle painted before the content.
//     Vector bbox analysis reports the whole sheet as inked.
async function whiteRectA4() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    `1 1 1 rg 0 0 ${A4[0]} ${A4[1]} re f\n` +
    text(72, 780, 14, 'There is a white rectangle under this') +
    text(72, 60, 9, 'and it covers the entire page'));
  await save('white-rect-a4.pdf', doc);
}

// 5 — an invisible OCR text layer (Tr 3) spanning the full sheet, exactly as a
//     scanner emits it, over a normally-margined visible page.
async function ocrLayerA4() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    `BT 3 Tr /F1 8 Tf 1 0 0 1 5 836 Tm (invisible ocr line at the very top) Tj ET\n` +
    `BT 3 Tr /F1 8 Tf 1 0 0 1 5 3 Tm (invisible ocr line at the very bottom) Tj ET\n` +
    text(72, 780, 14, 'Visible content with normal margins') +
    text(72, 60, 9, 'page 1'));
  await save('ocr-layer-a4.pdf', doc);
}

// 6 — one more Q than q. Prefixing `cm` onto this stream loses the transform
//     partway down the page; wrapping it in a Form XObject does not.
async function unbalancedQ() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    `q\n` + text(72, 780, 14, 'Above the stray Q') + `Q\n` +
    `Q\n` + // <- the stray one
    text(72, 400, 12, 'Below the stray Q') +
    text(72, 60, 9, 'footer'));
  await save('unbalanced-q.pdf', doc);
}

// 7 — /Contents as an array split at a token boundary with no trailing
//     whitespace. Concatenating without a separator welds "780" and "Tm" into
//     "780Tm" and the whole text object is lost.
async function splitContents() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  const a = doc.context.register(doc.context.stream('BT 0 Tr /F1 14 Tf 1 0 0 1 72 780'));
  const b = doc.context.register(doc.context.stream('Tm (Split across two streams) Tj ET\n' + text(72, 60, 9, 'footer')));
  const arr = PDFArray.withContext(doc.context);
  arr.push(a);
  arr.push(b);
  page.node.set(N('Contents'), arr);
  await save('split-contents.pdf', doc);
}

// 8 — mixed page sizes in one file, including a landscape page.
async function mixed() {
  const { doc, font } = await base();
  const p1 = withFont(doc.addPage(A4), font);
  setRawContent(doc, p1, text(72, 780, 14, 'A4 portrait') + text(72, 60, 9, 'footer'));
  const p2 = withFont(doc.addPage(A5), font);
  setRawContent(doc, p2, text(50, 540, 12, 'A5 portrait') + text(50, 40, 9, 'footer'));
  const p3 = withFont(doc.addPage([A4[1], A4[0]]), font);
  setRawContent(doc, p3, text(72, 540, 14, 'A4 landscape') + text(72, 40, 9, 'footer'));
  await save('mixed-sizes.pdf', doc);
}

// 9 — a blank page and a page that is already the target size.
async function blankAndLetter() {
  const { doc, font } = await base();
  withFont(doc.addPage(A4), font); // no content at all
  const p2 = withFont(doc.addPage(LETTER), font);
  setRawContent(doc, p2, text(72, 720, 14, 'Already Letter') + text(72, 60, 9, 'footer'));
  await save('blank-and-letter.pdf', doc);
}

// 10 — links, an outline with an /XYZ destination, and a CropBox smaller than
//      the MediaBox with content hidden outside it.
async function annotsAndDests() {
  const { doc, font } = await base();
  const p1 = withFont(doc.addPage(A4), font);
  const p2 = withFont(doc.addPage(A4), font);

  setRawContent(doc, p1,
    text(72, 780, 14, 'Page one') +
    text(72, 700, 11, 'This line is a link to page two') +
    // Drawn outside the CropBox below: must be clipped away, not resurrected.
    text(72, 20, 11, 'HIDDEN BY THE CROPBOX') +
    text(72, 120, 9, 'footer'));
  setRawContent(doc, p2, text(72, 500, 14, 'Page two target') + text(72, 60, 9, 'footer'));

  // CropBox trims 100 pt off the bottom.
  p1.node.set(N('CropBox'), doc.context.obj([0, 100, A4[0], A4[1]]));

  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: doc.context.obj([72, 695, 300, 715]),
    Border: doc.context.obj([0, 0, 1]),
    Dest: doc.context.obj([p2.ref, N('XYZ'), 72, 520, PDFNumber.of(0)]),
  });
  const annots = PDFArray.withContext(doc.context);
  annots.push(doc.context.register(link));
  p1.node.set(N('Annots'), annots);

  // A one-item outline pointing at page two.
  const outlinesRef = doc.context.nextRef();
  const itemRef = doc.context.nextRef();
  doc.context.assign(itemRef, doc.context.obj({
    Title: 'Go to page two',
    Parent: outlinesRef,
    Dest: doc.context.obj([p2.ref, N('XYZ'), 72, 520, PDFNumber.of(0)]),
  }));
  doc.context.assign(outlinesRef, doc.context.obj({
    Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1,
  }));
  doc.catalog.set(N('Outlines'), outlinesRef);

  await save('annots-and-dests.pdf', doc);
}

// 11 — a full-bleed coloured background. The wash is content, so the page
//      genuinely cannot be placed at 100%.
async function fullBleed() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    `0.1 0.3 0.6 rg 0 0 ${A4[0]} ${A4[1]} re f\n` +
    `1 1 1 rg\n` +
    text(72, 500, 20, 'Full bleed cover'));
  await save('full-bleed-a4.pdf', doc);
}

// 12 — a real AcroForm text field with a value. The widget annotation, the
//      field's appearance stream and the /Fields entry must all survive.
async function formField() {
  const { doc, font } = await base();
  const page = withFont(doc.addPage(A4), font);
  setRawContent(doc, page,
    text(72, 780, 14, 'Please fill in your name') +
    text(72, 60, 9, 'footer'));
  const field = doc.getForm().createTextField('applicant.name');
  field.setText('Saltfish');
  field.addToPage(page, { x: 72, y: 700, width: 300, height: 24, font });
  await save('form-field-a4.pdf', doc);
}

await mkdir(OUT, { recursive: true });
console.log('building fixtures:');
await normalA4();
await tightA4();
await rotatedA4();
await whiteRectA4();
await ocrLayerA4();
await unbalancedQ();
await splitContents();
await mixed();
await blankAndLetter();
await annotsAndDests();
await fullBleed();
await formField();
console.log('done');
