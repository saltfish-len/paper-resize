/**
 * Turn measurements into a concrete placement for every page.
 *
 * The whole point of the tool lives here: scaling is a last resort. A4 is
 * 49.89 pt taller than Letter, but a typical A4 document leaves far more than
 * that in its top and bottom margins, so the correct output for most pages is a
 * pure translation at exactly 100%. We only reach for a scale factor when the
 * ink itself genuinely does not fit, and then we use the largest factor that
 * works rather than a blanket "fit to page".
 */

import { compose, translate, scale as scaleM, rotation, transformRect } from './matrix.js';
import { orient } from './paper.js';

export const ANCHORS = {
  proportional: 'proportional',
  center: 'center',
  edge: 'edge',
};

/**
 * @param {Array} measurements  one entry per page, from measurePage(), plus `rotate`
 * @param {{w:number,h:number}} paper  target paper size, portrait orientation
 * @param {object} options
 */
export function planDocument(measurements, paper, options = {}) {
  const {
    anchor = ANCHORS.proportional,
    globalScale = true,
    safetyMarginPt = 0,
    fullBleedMode = 'fit', // 'fit' leaves a white border, 'fill' crops the bleed
    sizeTolerance = 1,
  } = options;

  const geometry = measurements.map((m) => deriveGeometry(m, paper, safetyMarginPt, fullBleedMode));

  // One scale for the whole document, unless asked otherwise. Deciding
  // per-page independently makes body text change size between pages, which
  // looks far worse than a marginally smaller uniform scale.
  //
  // Blank pages are excluded because their notional ink box is the whole sheet,
  // which would drag the entire document down to the paper ratio for nothing.
  // "Fill" pages are excluded because they intentionally scale *up*.
  const candidates = geometry
    .filter((g) => !g.blank && !g.fill)
    .map((g) => Math.min(1, g.fitScale));
  const documentScale = globalScale && candidates.length ? Math.min(...candidates) : null;

  return geometry.map((g, index) => {
    const s = g.fill
      ? g.fitScale
      : g.blank
        ? documentScale ?? 1
        : documentScale ?? Math.min(1, g.fitScale);

    const placement = place(g, s, anchor);
    const skip = canSkip(g, s, sizeTolerance);

    return {
      index,
      skip,
      scale: s,
      matrix: placement.matrix,
      target: g.target,
      paperBox: g.paperBox,
      blank: g.blank,
      isFullBleed: g.isFullBleed,
      rotate: g.rotate,
      sourceDisplay: { w: g.displayW, h: g.displayH },
      inkDisplay: g.ink,
      overflow: g.overflow,
      margins: g.margins,
      placedInk: placement.placedInk,
      action: skip ? 'skip' : s === 1 ? 'translate' : 'scale',
    };
  });
}

function deriveGeometry(m, paper, safetyMarginPt, fullBleedMode) {
  const [px0, py0, px1, py1] = m.pageBox;
  const w = px1 - px0;
  const h = py1 - py0;

  // Bake /Rotate into content space so the output page needs no /Rotate at all.
  const toDisplay = compose(rotation(m.rotate, w, h), translate(-px0, -py0));
  const rot = ((m.rotate % 360) + 360) % 360;
  const displayW = rot === 90 || rot === 270 ? h : w;
  const displayH = rot === 90 || rot === 270 ? w : h;

  const paperBox = orient(paper, displayW, displayH);
  const target = {
    x: safetyMarginPt,
    y: safetyMarginPt,
    w: Math.max(1, paperBox.w - 2 * safetyMarginPt),
    h: Math.max(1, paperBox.h - 2 * safetyMarginPt),
  };

  const blank = !m.contentBox;

  // A full-bleed page's background *is* content: shrinking only the foreground
  // would leave the wash floating in the middle of a white sheet. So the box we
  // have to fit is the whole page.
  let ink;
  if (blank) {
    ink = [0, 0, displayW, displayH];
  } else if (m.isFullBleed) {
    ink = [0, 0, displayW, displayH];
  } else {
    ink = transformRect(toDisplay, m.contentBox[0], m.contentBox[1], m.contentBox[2], m.contentBox[3]);
  }

  const inkW = Math.max(1e-6, ink[2] - ink[0]);
  const inkH = Math.max(1e-6, ink[3] - ink[1]);

  const fill = m.isFullBleed && fullBleedMode === 'fill';
  const fitScale = fill
    ? Math.max(target.w / inkW, target.h / inkH)
    : Math.min(target.w / inkW, target.h / inkH);

  return {
    toDisplay,
    rotate: rot,
    displayW,
    displayH,
    paperBox,
    target,
    ink,
    inkW,
    inkH,
    blank,
    isFullBleed: m.isFullBleed,
    fill,
    fitScale,
    // What a naive "just rewrite the MediaBox" would have lost, for reporting.
    overflow: {
      w: Math.max(0, inkW - target.w),
      h: Math.max(0, inkH - target.h),
    },
    margins: {
      left: ink[0],
      right: displayW - ink[2],
      bottom: ink[1],
      top: displayH - ink[3],
    },
  };
}

function place(g, s, anchor) {
  const scaledW = g.inkW * s;
  const scaledH = g.inkH * s;
  const freeW = g.target.w - scaledW;
  const freeH = g.target.h - scaledH;

  let offsetX;
  let offsetY;

  if (g.fill) {
    // Overflowing on purpose; centre so the crop is symmetric.
    offsetX = freeW / 2;
    offsetY = freeH / 2;
  } else if (anchor === ANCHORS.center) {
    offsetX = freeW / 2;
    offsetY = freeH / 2;
  } else if (anchor === ANCHORS.edge) {
    // Keep the original top and left margins at their literal size, so headers
    // and the binding edge land exactly where they did. All the gain or loss is
    // absorbed at the bottom and right.
    offsetX = clamp(g.margins.left, 0, Math.max(0, freeW));
    offsetY = clamp(freeH - g.margins.top, 0, Math.max(0, freeH));
  } else {
    // Proportional: split the leftover space in the same ratio as the original
    // margins. Asymmetric layouts (a binding gutter, a wide outer margin) stay
    // recognisably themselves, and a centred layout stays centred.
    offsetX = freeW * ratio(g.margins.left, g.margins.right);
    offsetY = freeH * ratio(g.margins.bottom, g.margins.top);
  }

  const matrix = compose(
    translate(g.target.x + offsetX, g.target.y + offsetY),
    scaleM(s),
    translate(-g.ink[0], -g.ink[1]),
    g.toDisplay,
  );

  return {
    matrix,
    placedInk: [
      g.target.x + offsetX,
      g.target.y + offsetY,
      g.target.x + offsetX + scaledW,
      g.target.y + offsetY + scaledH,
    ],
  };
}

function ratio(a, b) {
  const total = a + b;
  if (!Number.isFinite(total) || total <= 1e-6) return 0.5;
  return clamp(a / total, 0, 1);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * A page that is already the target size, upright, and not being scaled needs
 * no surgery at all. Leaving it completely untouched is both smaller and safer
 * than round-tripping it through a Form XObject for no reason.
 */
function canSkip(g, s, tolerance) {
  return (
    s === 1 &&
    g.rotate === 0 &&
    Math.abs(g.displayW - g.paperBox.w) <= tolerance &&
    Math.abs(g.displayH - g.paperBox.h) <= tolerance
  );
}
