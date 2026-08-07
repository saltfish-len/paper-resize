/**
 * Ink measurement by rasterisation.
 *
 * The obvious way to find what a page actually covers is to parse its content
 * stream and union the bounding boxes of every drawing operator (this is what
 * Ghostscript's `bbox` device does). It is also wrong in several common cases,
 * because a content stream describes *intent*, not result:
 *
 *   - a full-page white rectangle, drawn by almost every design tool on export,
 *     registers as ink covering the entire page;
 *   - the invisible OCR text layer in a scanned PDF (text render mode 3) draws
 *     nothing but has a bounding box, usually spanning the whole sheet;
 *   - content that a clipping path or the CropBox hides is still "drawn";
 *   - /Rotate has to be reasoned about separately.
 *
 * Rasterising and scanning pixels answers a different and better question:
 * what will actually come out of the printer? All four cases above collapse to
 * nothing at all — a white rectangle on white paper is invisible, mode-3 text
 * renders no pixels, clipped content is clipped, and pdf.js applies /Rotate for
 * us. The cost is quantisation, which at 144 dpi is 0.5 pt against the ~50 pt
 * of headroom we are trying to measure.
 */

const DEFAULTS = {
  dpi: 144,
  /** Channel distance from the reference colour before a pixel counts as ink. */
  inkThreshold: 6,
  /** Fraction of a row/column that must be ink before the row/column counts. */
  denoise: 0,
  /** Colour-match tolerance when deciding the four corners agree. */
  cornerTolerance: 8,
};

/**
 * @returns {{
 *   contentBox: [number,number,number,number] | null,  // PDF user space, unrotated
 *   pageBox:    [number,number,number,number],
 *   isFullBleed: boolean,
 *   background: [number,number,number],
 *   coverage: number,
 * }}
 */
export async function measurePage(page, canvas, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const renderScale = opts.dpi / 72;

  // rotation: 0 gives us unrotated content space, which is the space the
  // page's content stream — and therefore our output matrix — lives in.
  const viewport = page.getViewport({ scale: renderScale, rotation: 0 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 'print' intent matters: it renders annotations flagged for printing (a
  // stamp or a filled form field near the edge is ink that has to fit) and
  // skips the ones flagged view-only.
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: 'print',
    annotationMode: 2 /* AnnotationMode.ENABLE_FORMS */,
    background: '#ffffff',
  }).promise;

  const { data } = ctx.getImageData(0, 0, width, height);

  const background = detectBackground(data, width, height, opts.cornerTolerance);
  const isFullBleed = colourDistance(background, [255, 255, 255]) > opts.inkThreshold;

  const box = scanInk(data, width, height, background, opts);

  const view = page.view; // [x0, y0, x1, y1] — pdf.js already intersects CropBox with MediaBox
  const pageBox = [view[0], view[1], view[2], view[3]];

  let contentBox = null;
  let coverage = 0;
  if (box) {
    // Grow by one pixel on each side before converting: the scan can only ever
    // under-report at the edges (antialiasing fades the last row towards the
    // background), and under-reporting is the direction that silently clips.
    const [p0x, p0y] = viewport.convertToPdfPoint(box.x0 - 1, box.y1 + 1);
    const [p1x, p1y] = viewport.convertToPdfPoint(box.x1 + 1, box.y0 - 1);
    contentBox = [
      Math.max(pageBox[0], Math.min(p0x, p1x)),
      Math.max(pageBox[1], Math.min(p0y, p1y)),
      Math.min(pageBox[2], Math.max(p0x, p1x)),
      Math.min(pageBox[3], Math.max(p0y, p1y)),
    ];
    coverage = box.count / (width * height);
  }

  return { contentBox, pageBox, isFullBleed, background, coverage };
}

/**
 * If all four corners agree on a colour, the page has a background wash rather
 * than white paper, and "ink" has to be measured relative to that colour or the
 * whole sheet reads as covered.
 */
function detectBackground(data, width, height, tolerance) {
  const inset = Math.min(4, width - 1, height - 1);
  const corners = [
    [inset, inset],
    [width - 1 - inset, inset],
    [inset, height - 1 - inset],
    [width - 1 - inset, height - 1 - inset],
  ].map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });

  const [first] = corners;
  const agree = corners.every((c) => colourDistance(c, first) <= tolerance);
  return agree ? first : [255, 255, 255];
}

function colourDistance(a, b) {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

function scanInk(data, width, height, background, opts) {
  const [br, bg, bb] = background;
  const threshold = opts.inkThreshold;

  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  let count = 0;

  for (let y = 0; y < height; y++) {
    let rowCount = 0;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue; // transparent, will print as paper
      const dr = data[i] - br;
      const dg = data[i + 1] - bg;
      const db = data[i + 2] - bb;
      const diff =
        (dr < 0 ? -dr : dr) > (dg < 0 ? -dg : dg)
          ? dr < 0 ? -dr : dr
          : dg < 0 ? -dg : dg;
      const maxDiff = diff > (db < 0 ? -db : db) ? diff : db < 0 ? -db : db;
      if (maxDiff > threshold) {
        rowCount++;
        colInk[x]++;
      }
    }
    rowInk[y] = rowCount;
    count += rowCount;
  }

  if (count === 0) return null;

  // The denoise floor is expressed as a fraction of the axis so that it means
  // the same thing at any dpi. At 0 it is a plain "any ink at all" scan, which
  // is the honest default — dropping rows is a judgement call the user should
  // opt into after seeing the preview.
  const rowFloor = Math.max(1, Math.round(opts.denoise * width));
  const colFloor = Math.max(1, Math.round(opts.denoise * height));

  const y0 = firstIndex(rowInk, rowFloor);
  const y1 = lastIndex(rowInk, rowFloor);
  const x0 = firstIndex(colInk, colFloor);
  const x1 = lastIndex(colInk, colFloor);

  // Denoising can eliminate every row (a page whose only content is fainter
  // than the floor). Fall back to the unfiltered scan rather than claiming the
  // page is blank.
  if (y0 < 0 || x0 < 0) {
    const ry0 = firstIndex(rowInk, 1);
    const ry1 = lastIndex(rowInk, 1);
    const rx0 = firstIndex(colInk, 1);
    const rx1 = lastIndex(colInk, 1);
    return { x0: rx0, y0: ry0, x1: rx1, y1: ry1, count };
  }

  return { x0, y0, x1, y1, count };
}

function firstIndex(arr, floor) {
  for (let i = 0; i < arr.length; i++) if (arr[i] >= floor) return i;
  return -1;
}

function lastIndex(arr, floor) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= floor) return i;
  return -1;
}
