/**
 * The PDF surgery.
 *
 * Rather than building a fresh document and copying pages into it — the usual
 * approach, and the reason most tools of this kind silently drop links, form
 * fields and comments — we rewrite each page in place:
 *
 *   1. the page's existing content stream becomes a Form XObject, verbatim;
 *   2. the page's new content stream is just `q <matrix> cm /X0 Do Q`;
 *   3. the page's boxes are replaced and /Rotate is zeroed;
 *   4. /Annots are kept and their geometry is pushed through the same matrix.
 *
 * Everything else in the file — the structure tree, metadata, embedded files,
 * AcroForm, fonts — is never touched, so it survives by construction.
 *
 * Step 1 also happens to be the robust answer to unbalanced q/Q operators. A
 * surprising number of real PDFs have one more `Q` than `q`; prefixing such a
 * stream with `cm` would let the stray `Q` pop our transform off the stack
 * partway down the page. Inside a Form XObject the graphics state is isolated,
 * so it cannot escape.
 */

const {
  PDFName,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFNull,
  PDFRawStream,
  decodePDFRawStream,
} = window.PDFLib;

import { apply, transformRect, scaleOf } from './matrix.js';

const N = (name) => PDFName.of(name);

/** Inspect for the conditions we must refuse or warn about before touching anything. */
export function inspectDocument(pdfDoc) {
  const context = pdfDoc.context;
  const catalog = pdfDoc.catalog;
  const warnings = [];
  let fatal = null;

  if (pdfDoc.isEncrypted) {
    fatal =
      'This PDF is encrypted. pdf-lib cannot decrypt content streams, so rewriting it ' +
      'would produce a corrupt file. Remove the password first (print to PDF, or any ' +
      'decrypting tool) and try again.';
  }

  const acroForm = context.lookupMaybe(catalog.get(N('AcroForm')), PDFDict);
  if (acroForm) {
    const sigFlags = context.lookupMaybe(acroForm.get(N('SigFlags')), PDFNumber);
    if (sigFlags && (sigFlags.asNumber() & 1) === 1) {
      warnings.push({
        key: 'signature',
        text:
          'This PDF carries a digital signature. Any modification invalidates it — ' +
          'the output will open fine but will be reported as an altered document.',
      });
    }
  }

  if (catalog.get(N('StructTreeRoot'))) {
    warnings.push({
      key: 'tagged',
      text:
        'This is a tagged (accessible) PDF. The tag tree is preserved and each page ' +
        'form carries its /StructParents, but wrapping content in a Form XObject can ' +
        'still degrade reading order in strict screen readers.',
    });
  }

  return { fatal, warnings };
}

/**
 * Apply a plan to a loaded PDFDocument, in place.
 * @returns {{ rewritten: number, skipped: number, annotations: number, destinations: number }}
 */
export function applyPlan(pdfDoc, plan) {
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();

  const matrixByPage = new Map();
  pages.forEach((page, i) => {
    if (!plan[i].skip) matrixByPage.set(page.ref.tag, plan[i].matrix);
  });

  const formCache = new Map();
  const stats = { rewritten: 0, skipped: 0, annotations: 0, destinations: 0 };

  pages.forEach((page, i) => {
    const step = plan[i];
    if (step.skip) {
      stats.skipped++;
      return;
    }
    stats.annotations += rewritePage(context, page, step, formCache);
    stats.rewritten++;
  });

  stats.destinations = remapDestinations(pdfDoc, matrixByPage);
  return stats;
}

function rewritePage(context, page, step, formCache) {
  const node = page.node;
  const media = page.getMediaBox();
  const crop = page.getCropBox() ?? media;

  // The form's BBox doubles as a clip. Using the CropBox means content the
  // viewer already hides stays hidden instead of reappearing on the new page.
  const bbox = [
    Math.max(media.x, crop.x),
    Math.max(media.y, crop.y),
    Math.min(media.x + media.width, crop.x + crop.width),
    Math.min(media.y + media.height, crop.y + crop.height),
  ];

  const formRef = buildFormXObject(context, node, bbox, formCache);

  const key = 'X0';
  const xobjects = context.obj({});
  xobjects.set(N(key), formRef);
  node.set(
    N('Resources'),
    context.obj({
      XObject: xobjects,
      ProcSet: context.obj(['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI']),
    }),
  );

  const m = step.matrix.map(fmtNumber).join(' ');
  node.set(N('Contents'), context.register(context.stream(`q\n${m} cm\n/${key} Do\nQ\n`)));

  const { w, h } = step.paperBox;
  node.set(N('MediaBox'), context.obj([0, 0, w, h]));
  node.set(N('CropBox'), context.obj([0, 0, w, h]));

  // Trim/Bleed/Art are meaningful to a print shop, so move them rather than
  // dropping them, and clamp so they stay inside the new media box.
  for (const boxName of ['BleedBox', 'TrimBox', 'ArtBox']) {
    const box = context.lookupMaybe(node.get(N(boxName)), PDFArray);
    if (!box) continue;
    const nums = readNumbers(context, box, 4);
    if (!nums) {
      node.delete(N(boxName));
      continue;
    }
    const r = transformRect(step.matrix, nums[0], nums[1], nums[2], nums[3]);
    node.set(
      N(boxName),
      context.obj([
        clamp(r[0], 0, w),
        clamp(r[1], 0, h),
        clamp(r[2], 0, w),
        clamp(r[3], 0, h),
      ]),
    );
  }

  // /Rotate is baked into the matrix now. Set it explicitly rather than
  // deleting it, because it is inheritable and a parent Pages node may set it.
  node.set(N('Rotate'), context.obj(0));

  return remapAnnots(context, node, step.matrix);
}

function buildFormXObject(context, node, bbox, cache) {
  const contentsEntry = node.get(N('Contents'));
  const resources = node.getInheritableAttribute(N('Resources'));
  const group = node.get(N('Group'));
  const structParents = node.get(N('StructParents'));

  const cacheKey = [
    refTag(contentsEntry),
    refTag(resources),
    bbox.map((v) => v.toFixed(3)).join(','),
  ].join('|');
  if (refTag(contentsEntry) && cache.has(cacheKey)) return cache.get(cacheKey);

  const dict = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: context.obj([bbox[0], bbox[1], bbox[2], bbox[3]]),
    Matrix: context.obj([1, 0, 0, 1, 0, 0]),
  };
  if (resources) dict.Resources = resources;
  // A page-level transparency group has to travel with the content it applies
  // to, or blend modes and soft masks render differently.
  if (group) dict.Group = group;
  if (structParents) dict.StructParents = structParents;

  const { bytes, filter, decodeParms } = readContents(context, contentsEntry);
  if (filter) dict.Filter = filter;
  if (decodeParms) dict.DecodeParms = decodeParms;

  const ref = context.register(context.stream(bytes, dict));
  if (refTag(contentsEntry)) cache.set(cacheKey, ref);
  return ref;
}

/**
 * Returns the page's content bytes. When /Contents is a single stream we hand
 * back its *encoded* bytes together with its filter, which avoids a decompress
 * and recompress round trip — and avoids inflating the output file, since
 * pdf-lib does not re-deflate streams on save.
 */
function readContents(context, entry) {
  const value = context.lookup(entry);

  if (value instanceof PDFRawStream) {
    return {
      bytes: value.contents,
      filter: value.dict.get(N('Filter')),
      decodeParms: value.dict.get(N('DecodeParms')),
    };
  }

  if (value instanceof PDFArray) {
    const parts = [];
    for (const element of value.asArray()) {
      const stream = context.lookup(element);
      const decoded = decodeStream(stream);
      if (!decoded) continue;
      parts.push(decoded);
      // The separator is not optional: the spec allows a token to be split
      // across the boundary between two content streams, and concatenating
      // without whitespace can weld two operators into one.
      parts.push(new Uint8Array([0x0a]));
    }
    return { bytes: concat(parts), filter: null, decodeParms: null };
  }

  const decoded = decodeStream(value);
  return { bytes: decoded ?? new Uint8Array(0), filter: null, decodeParms: null };
}

function decodeStream(stream) {
  if (!stream) return null;
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream.getContents === 'function') return stream.getContents();
  return null;
}

/** Annotation geometry that has to follow the content. */
function remapAnnots(context, node, matrix) {
  const annots = context.lookupMaybe(node.get(N('Annots')), PDFArray);
  if (!annots) return 0;

  const s = scaleOf(matrix);
  let touched = 0;

  for (const entry of annots.asArray()) {
    const annot = context.lookupMaybe(entry, PDFDict);
    if (!annot) continue;

    const rect = context.lookupMaybe(annot.get(N('Rect')), PDFArray);
    const nums = rect && readNumbers(context, rect, 4);
    if (nums) {
      const r = transformRect(matrix, nums[0], nums[1], nums[2], nums[3]);
      annot.set(N('Rect'), context.obj([r[0], r[1], r[2], r[3]]));
      touched++;
    }

    // Point lists: highlight quads, polygon vertices, line endpoints, callouts.
    for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) {
      remapPointList(context, annot, key, matrix);
    }

    // /InkList is a list of lists.
    const inkList = context.lookupMaybe(annot.get(N('InkList')), PDFArray);
    if (inkList) {
      inkList.asArray().forEach((strokeEntry, i) => {
        const stroke = context.lookupMaybe(strokeEntry, PDFArray);
        if (stroke) inkList.set(i, mapPoints(context, stroke, matrix));
      });
    }

    // /RD is a set of inset distances, not coordinates — it scales, it does not move.
    const rd = context.lookupMaybe(annot.get(N('RD')), PDFArray);
    const rdNums = rd && readNumbers(context, rd, 4);
    if (rdNums) annot.set(N('RD'), context.obj(rdNums.map((v) => v * s)));

    scaleBorderWidth(context, annot, s);

    // The appearance stream needs no attention: a viewer maps its /BBox onto
    // /Rect, so moving and uniformly scaling the rect carries it along. This is
    // also why the scale must stay uniform — a non-uniform one would distort
    // every stamp and signature on the page.
  }

  return touched;
}

function remapPointList(context, annot, key, matrix) {
  const arr = context.lookupMaybe(annot.get(N(key)), PDFArray);
  if (!arr || arr.size() < 2) return;
  annot.set(N(key), mapPoints(context, arr, matrix));
}

function mapPoints(context, arr, matrix) {
  const values = readNumbers(context, arr, arr.size());
  if (!values || values.length % 2 !== 0) return arr;
  const out = [];
  for (let i = 0; i < values.length; i += 2) {
    const [x, y] = apply(matrix, values[i], values[i + 1]);
    out.push(x, y);
  }
  return context.obj(out);
}

function scaleBorderWidth(context, annot, s) {
  const bs = context.lookupMaybe(annot.get(N('BS')), PDFDict);
  if (bs) {
    const w = context.lookupMaybe(bs.get(N('W')), PDFNumber);
    if (w) bs.set(N('W'), context.obj(w.asNumber() * s));
  }
  const border = context.lookupMaybe(annot.get(N('Border')), PDFArray);
  if (border && border.size() >= 3) {
    const values = readNumbers(context, border, 3);
    if (values) {
      values.forEach((v, i) => border.set(i, context.obj(v * s)));
    }
  }
}

/**
 * Destinations store raw page coordinates, so every bookmark, link and named
 * destination points at the wrong spot once the content moves. This is the step
 * that is almost always missing from home-grown resizers.
 */
function remapDestinations(pdfDoc, matrixByPage) {
  const context = pdfDoc.context;
  const catalog = pdfDoc.catalog;
  const seen = new Set();
  let count = 0;

  const visitDest = (entry) => {
    const dest = context.lookup(entry);
    if (!(dest instanceof PDFArray)) return;
    const tag = refTag(entry);
    if (tag) {
      if (seen.has(tag)) return;
      seen.add(tag);
    }
    if (remapDest(context, dest, matrixByPage)) count++;
  };

  const visitTarget = (holder) => {
    if (!(holder instanceof PDFDict)) return;
    if (holder.get(N('Dest'))) visitDest(holder.get(N('Dest')));
    const action = context.lookupMaybe(holder.get(N('A')), PDFDict);
    if (action) {
      const type = action.get(N('S'));
      // Only plain GoTo actions address this file. /GoToR and /GoToE target
      // another document, whose coordinates we have no business rewriting.
      if (type instanceof PDFName && type.asString() === '/GoTo') {
        if (action.get(N('D'))) visitDest(action.get(N('D')));
      }
    }
  };

  // Outline tree.
  const outlines = context.lookupMaybe(catalog.get(N('Outlines')), PDFDict);
  if (outlines) walkOutline(context, outlines, visitTarget);

  // Catalog-level open action.
  visitTarget(catalog);

  // Named destinations, both the modern name tree and the legacy dictionary.
  const names = context.lookupMaybe(catalog.get(N('Names')), PDFDict);
  if (names) {
    const destsTree = context.lookupMaybe(names.get(N('Dests')), PDFDict);
    if (destsTree) walkNameTree(context, destsTree, (value) => {
      const target = context.lookup(value);
      if (target instanceof PDFArray) visitDest(value);
      else if (target instanceof PDFDict && target.get(N('D'))) visitDest(target.get(N('D')));
    });
  }
  const legacyDests = context.lookupMaybe(catalog.get(N('Dests')), PDFDict);
  if (legacyDests) {
    for (const [, value] of legacyDests.entries()) visitDest(value);
  }

  // Link and widget annotations.
  for (const page of pdfDoc.getPages()) {
    const annots = context.lookupMaybe(page.node.get(N('Annots')), PDFArray);
    if (!annots) continue;
    for (const entry of annots.asArray()) {
      visitTarget(context.lookupMaybe(entry, PDFDict));
    }
  }

  return count;
}

function walkOutline(context, node, visit, depth = 0) {
  if (depth > 64) return; // malformed files can contain cycles
  let child = context.lookupMaybe(node.get(N('First')), PDFDict);
  let guard = 0;
  while (child && guard++ < 10000) {
    visit(child);
    walkOutline(context, child, visit, depth + 1);
    child = context.lookupMaybe(child.get(N('Next')), PDFDict);
  }
}

function walkNameTree(context, node, visit, depth = 0) {
  if (depth > 64) return;
  const names = context.lookupMaybe(node.get(N('Names')), PDFArray);
  if (names) {
    const arr = names.asArray();
    for (let i = 1; i < arr.length; i += 2) visit(arr[i]);
  }
  const kids = context.lookupMaybe(node.get(N('Kids')), PDFArray);
  if (kids) {
    for (const kid of kids.asArray()) {
      const kidDict = context.lookupMaybe(kid, PDFDict);
      if (kidDict) walkNameTree(context, kidDict, visit, depth + 1);
    }
  }
}

function remapDest(context, dest, matrixByPage) {
  const arr = dest.asArray();
  if (arr.length < 2) return false;

  const pageEntry = arr[0];
  if (!(pageEntry instanceof PDFRef)) return false; // page-number form: remote dest
  const matrix = matrixByPage.get(pageEntry.tag);
  if (!matrix) return false;

  const kind = arr[1];
  if (!(kind instanceof PDFName)) return false;

  const num = (i) => {
    if (i >= arr.length) return null;
    const value = context.lookup(arr[i]);
    if (!value || value === PDFNull || !(value instanceof PDFNumber)) return null;
    return value.asNumber();
  };
  const put = (i, v) => dest.set(i, context.obj(v));

  switch (kind.asString()) {
    case '/XYZ': {
      const left = num(2);
      const top = num(3);
      if (left === null && top === null) return false;
      const [x, y] = apply(matrix, left ?? 0, top ?? 0);
      if (left !== null) put(2, x);
      if (top !== null) put(3, y);
      // The zoom factor at index 4 is deliberately left alone: it is a viewer
      // magnification hint relative to the page, not a coordinate.
      return true;
    }
    case '/FitH':
    case '/FitBH': {
      const top = num(2);
      if (top === null) return false;
      put(2, apply(matrix, 0, top)[1]);
      return true;
    }
    case '/FitV':
    case '/FitBV': {
      const left = num(2);
      if (left === null) return false;
      put(2, apply(matrix, left, 0)[0]);
      return true;
    }
    case '/FitR': {
      const l = num(2);
      const b = num(3);
      const r = num(4);
      const t = num(5);
      if ([l, b, r, t].some((v) => v === null)) return false;
      const box = transformRect(matrix, l, b, r, t);
      put(2, box[0]);
      put(3, box[1]);
      put(4, box[2]);
      put(5, box[3]);
      return true;
    }
    default:
      return false; // /Fit and /FitB carry no coordinates
  }
}

function readNumbers(context, arr, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const value = context.lookup(arr.get(i));
    if (!(value instanceof PDFNumber)) return null;
    out.push(value.asNumber());
  }
  return out;
}

function refTag(entry) {
  return entry instanceof PDFRef ? entry.tag : null;
}

function concat(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Fixed notation only — PDF has no syntax for exponents. */
function fmtNumber(v) {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
}
