// Turn one letter into the fixed 32x32 picture the AI uses.
// The same function is used for real photos, for the library, and for the
// synthetic training letters, so the AI always sees letters the same way.

export const SIZE = 32;

/**
 * mask: Uint8Array of the letter's own ink (1 = ink) of size w*h (already cropped to the letter).
 * Returns Float32Array(32*32), 1 = ink, 0 = klaf. Aspect ratio is kept (letter centered in a square).
 */
export function normalizeMask(mask, w, h) {
  const out = new Float32Array(SIZE * SIZE);
  const side = Math.max(w, h) * 1.15 + 2;
  const ox = (side - w) / 2, oy = (side - h) / 2;
  const sub = 4, step = side / SIZE / sub;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let s = 0;
    for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const sx = Math.floor(x * sub * step + (i + 0.5) * step - ox);
      const sy = Math.floor(y * sub * step + (j + 0.5) * step - oy);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) s += mask[sy * w + sx];
    }
    out[y * SIZE + x] = s / (sub * sub);
  }
  return out;
}

/** Cut the ink of the given component ids out of a label image. */
export function maskFromLabels(labels, imgW, box, ids) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  const set = new Set(ids);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (set.has(labels[(box.y0 + y) * imgW + box.x0 + x])) m[y * w + x] = 1;
  }
  return { m, w, h };
}

/** A small grayscale view of the photo around a box, for showing in the review list. */
export function viewCrop(gray, box, size = 48) {
  const out = new Uint8Array(size * size);
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const side = Math.max(bw, bh) * 1.4 + 4;
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.round(cx - side / 2 + ((x + 0.5) * side) / size);
    const sy = Math.round(cy - side / 2 + ((y + 0.5) * side) / size);
    let v = sx >= 0 && sy >= 0 && sx < gray.w && sy < gray.h ? gray.d[sy * gray.w + sx] : 255;
    // fade the neighbouring letters so it is clear which letter is meant
    if (sx < box.x0 - 1 || sx > box.x1 + 1 || sy < box.y0 - 1 || sy > box.y1 + 1) v = 255 - (255 - v) * 0.25;
    out[y * size + x] = v;
  }
  return out;
}

/** Store a 32x32 float letter compactly as bytes. */
export const toBytes = (f) => Uint8Array.from(f, (v) => Math.round(v * 255));
export const fromBytes = (b) => Float32Array.from(b, (v) => v / 255);
