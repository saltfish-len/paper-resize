/**
 * 2D affine matrices in PDF's own convention: [a b c d e f] means
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * which is exactly the argument order of the `cm` operator.
 */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Compose: returns the matrix that applies `inner` first, then `outer`. */
export function mul(outer, inner) {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Compose a whole chain, left-to-right = outermost-to-innermost. */
export function compose(...matrices) {
  return matrices.reduce(mul, IDENTITY);
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const scale = (s) => [s, 0, 0, s, 0, 0];

/**
 * The matrix that bakes a /Rotate value into content coordinates.
 *
 * /Rotate is a *display* instruction — "turn the sheet this many degrees
 * clockwise before showing it" — so the content stream itself is written in
 * unrotated space. Baking it in lets us emit pages with /Rotate 0, which
 * removes a whole class of viewer/printer disagreement.
 *
 * `w` and `h` are the unrotated page box dimensions, and the input point is
 * expected to be relative to the box origin (translate first).
 */
export function rotation(degrees, w, h) {
  switch (((degrees % 360) + 360) % 360) {
    case 90:
      return [0, -1, 1, 0, 0, w]; // (x,y) -> (y, w-x)
    case 180:
      return [-1, 0, 0, -1, w, h]; // (x,y) -> (w-x, h-y)
    case 270:
      return [0, 1, -1, 0, h, 0]; // (x,y) -> (h-y, x)
    default:
      return IDENTITY;
  }
}

/**
 * Transform an axis-aligned rect and return the axis-aligned bounding box of
 * the result. Correct for any affine matrix, not just the 90-degree ones.
 */
export function transformRect(m, x0, y0, x1, y1) {
  const pts = [
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x0, y1),
    apply(m, x1, y1),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Uniform scale factor of a matrix, via the square root of |det|. */
export function scaleOf(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}
