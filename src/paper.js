/** Paper sizes, in PDF points (1 pt = 1/72 in). */

export const MM = 72 / 25.4; // points per millimetre

export const PAPER = {
  letter: { label: 'Letter', w: 612, h: 792 },
  legal: { label: 'Legal', w: 612, h: 1008 },
  tabloid: { label: 'Tabloid', w: 792, h: 1224 },
  a3: { label: 'A3', w: 841.89, h: 1190.55 },
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  a5: { label: 'A5', w: 419.53, h: 595.28 },
  b5: { label: 'B5 (JIS)', w: 515.91, h: 728.5 },
};

/**
 * Name a page size for display. Scanners and older producers round the A4
 * point size in several different directions (595x842, 596x843, 595.22x842),
 * so recognition needs a tolerance rather than equality.
 */
export function describeSize(w, h, tolerance = 3) {
  const portrait = Math.min(w, h);
  const landscape = Math.max(w, h);
  for (const [key, p] of Object.entries(PAPER)) {
    if (
      Math.abs(portrait - Math.min(p.w, p.h)) <= tolerance &&
      Math.abs(landscape - Math.max(p.w, p.h)) <= tolerance
    ) {
      return { key, label: p.label, exact: portrait === Math.min(p.w, p.h) && landscape === Math.max(p.w, p.h) };
    }
  }
  return { key: null, label: null, exact: false };
}

/** Orient a target size to match the source page's orientation. */
export function orient(target, sourceW, sourceH) {
  const wantLandscape = sourceW > sourceH;
  const isLandscape = target.w > target.h;
  return wantLandscape === isLandscape
    ? { w: target.w, h: target.h }
    : { w: target.h, h: target.w };
}

export const ptToMm = (pt) => pt / MM;
export const mmToPt = (mm) => mm * MM;

export function fmtMm(pt, digits = 1) {
  return `${ptToMm(pt).toFixed(digits)} mm`;
}
