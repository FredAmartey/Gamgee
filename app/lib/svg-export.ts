import { canvasToBlob, loadImage } from "./brand-kit";

/**
 * Vectorize a (flat, limited-color) raster logo to an SVG string by tracing it
 * on-device with imagetracerjs. Tuned for clean logo art: a small color count,
 * speckle removal, fills-only (no strokes), and a light blur to tame the JPEG/AA
 * edges. This is an auto-trace, not a hand-redraw: good enough for scalable
 * exports of these flat marks.
 */
const LOGO_TRACE_OPTS = {
  mincolorratio: 0,
  // Drops leftover specks. Safe to keep meaningful now that the palette has no
  // anti-aliasing colours in it, because there is no fringe left to preserve.
  pathomit: 16,
  // Curve-fitting tolerance. This was 2 to stop the tracer chasing JPEG noise
  // along every edge, which came out as furry letterforms. Posterizing removes
  // that noise before the tracer ever sees it, so the tolerance is free to drop
  // back to 1 and follow real corners again: measured over the test set it costs
  // ~6KB per logo and is the better half of every fidelity comparison.
  ltres: 1,
  qtres: 1,
  // Freeze the palette. imagetracer treats `pal` as a STARTING palette and then
  // runs `colorquantcycles` rounds of k-means that replace each entry with the
  // mean of every pixel assigned to it - background and anti-aliased edge pixels
  // included. At the default of 3 that dragged our carefully interior-sampled
  // ink colours by up to 104 (sum of channel deltas) toward the backdrop, which
  // is where the washed-out fills and grey-blue seams in the exports came from.
  // 1 runs the assignment pass without ever averaging, so what we ask for is
  // what gets drawn.
  colorquantcycles: 1,
  strokewidth: 0,
  linefilter: true,
  roundcoords: 2,
  // No blur. It smears thin strokes and accent colours into their neighbours
  // before quantization runs; edge smoothing is ltres/qtres' job, not blur's.
  blurradius: 0,
  blurdelta: 20,
  // Emit `<svg viewBox="0 0 w h">` with NO fixed width/height so the export
  // actually scales into a favicon slot, a CSS-sized <img>, or a print sheet.
  viewbox: true,
};

/** Ink clusters to look for before near-duplicates are merged away. */
const INK_CLUSTERS = 12;
/** Palette entries closer than this (sum of channel deltas) collapse into one. */
const MERGE_DISTANCE = 30;

/**
 * Flatten a near-uniform background to one exact color before tracing. FLUX
 * outputs a "white" background that's actually full of faint noise, which the
 * tracer would otherwise turn into hundreds of tiny speckle paths. Snapping
 * every pixel within tolerance of the corner-sampled background to that single
 * color collapses it into one clean region.
 *
 * The tolerance has to be earned, not assumed. A flat backdrop wants an
 * aggressive snap; a deliberately gradient backdrop wants almost none, because
 * flattening hard against a gradient erases it. Measured across a test set, a
 * fixed aggressive tolerance turned a blue-to-magenta gradient wordmark into
 * one flat purple rectangle (error 12.6); deciding from the corners drops that
 * to 3.6 and leaves every flat-background logo untouched.
 */
function flattenBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): [number, number, number] {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  // Sample only OPAQUE corners: a transparent corner's RGB is usually (0,0,0)
  // and would drag the reference toward black. The caller fills white first,
  // so this is belt-and-braces, but the shared pattern must stay alpha-aware
  // (the alpha-blind version of this is exactly what broke makeTransparent).
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
  const sampled: [number, number, number][] = [];
  let br = 0,
    bg = 0,
    bb = 0,
    nc = 0;
  for (const c of corners) {
    if (d[c + 3] < 200) continue;
    sampled.push([d[c], d[c + 1], d[c + 2]]);
    br += d[c];
    bg += d[c + 1];
    bb += d[c + 2];
    nc++;
  }
  if (nc === 0) return [255, 255, 255]; // nothing opaque to key against
  br = Math.round(br / nc);
  bg = Math.round(bg / nc);
  bb = Math.round(bb / nc);
  // Corners that disagree with each other mean the backdrop is itself a
  // gradient, so only denoise it; corners that agree mean a flat backdrop,
  // where the generous snap is what kills FLUX's speckle.
  let spread = 0;
  for (const a of sampled) {
    for (const b of sampled) {
      spread = Math.max(
        spread,
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]),
      );
    }
  }
  const gradientBackdrop = spread > 40;

  // Where is the artwork? A coarse grid marking cells that contain firmly
  // inked pixels, then dilated so the zone also covers the soft fade around
  // each shape rather than stopping at its hard core.
  // Cell size in pixels, so the protected margin around artwork stays the same
  // physical size whether we are tracing a 1024 or a 2048 canvas.
  const CELL = 8 * Math.max(1, Math.round(w / 1024));
  const gw = Math.ceil(w / CELL);
  const gh = Math.ceil(h / CELL);
  const inked = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dist =
        Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
      if (dist > 200) {
        inked[((y / CELL) | 0) * gw + ((x / CELL) | 0)] = 1;
      }
    }
  }
  const PAD = 4; // cells, so ~32px of protected margin around the artwork
  const nearArt = new Uint8Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      if (!inked[cy * gw + cx]) continue;
      for (let dy = -PAD; dy <= PAD; dy++) {
        for (let dx = -PAD; dx <= PAD; dx++) {
          const ny = cy + dy;
          const nx = cx + dx;
          if (ny >= 0 && ny < gh && nx >= 0 && nx < gw) nearArt[ny * gw + nx] = 1;
        }
      }
    }
  }

  // Two zones. Out in the open the snap can be generous, because that is where
  // a model's soft vignette lives and nothing is lost by flattening it. Close to
  // the artwork it has to be gentle: a faded arrow tail or a pale highlight sits
  // within 155 of white, so the generous tolerance simply deletes it — which is
  // exactly how both accent arrows lost their tapered tails.
  const FAR_TOL = 60 * 3;
  const NEAR_TOL = 30;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 24) {
        // transparent → treat as the flat background too
        d[i] = br;
        d[i + 1] = bg;
        d[i + 2] = bb;
        d[i + 3] = 255;
        continue;
      }
      const dist =
        Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
      const tol = gradientBackdrop
        ? 24
        : nearArt[((y / CELL) | 0) * gw + ((x / CELL) | 0)]
          ? NEAR_TOL
          : FAR_TOL;
      if (dist < tol) {
        d[i] = br;
        d[i + 1] = bg;
        d[i + 2] = bb;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return [br, bg, bb];
}

/**
 * 3x3 median filter over the colour channels.
 *
 * These logos arrive as JPEG, and JPEG ringing is impulse-like noise clinging to
 * every edge — exactly what a median removes while leaving straight edges and
 * corners where they are. A blur would soften the shapes instead. Worth doing
 * for its own sake: across the test set it both improved fidelity and made the
 * files smaller, because each speck it removes is a path the tracer won't emit.
 */
function denoise(d: Uint8ClampedArray, w: number, h: number) {
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w;
    const r1 = y * w;
    const r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const nw = (r0 + x - 1) * 4;
      const n = (r0 + x) * 4;
      const ne = (r0 + x + 1) * 4;
      const we = (r1 + x - 1) * 4;
      const ce = (r1 + x) * 4;
      const ea = (r1 + x + 1) * 4;
      const sw = (r2 + x - 1) * 4;
      const so = (r2 + x) * 4;
      const se = (r2 + x + 1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        // Paeth's 19-comparison median-of-9 network, in locals. The obvious
        // version (collect 9 into an array, sort, take the middle) runs 12.6M
        // sorts on a 2048 canvas and measured 2.3x slower for a bit-identical
        // result. Each step is a compare-exchange; p4 holds the median at the
        // end.
        let p0 = src[nw + ch];
        let p1 = src[n + ch];
        let p2 = src[ne + ch];
        let p3 = src[we + ch];
        let p4 = src[ce + ch];
        let p5 = src[ea + ch];
        let p6 = src[sw + ch];
        let p7 = src[so + ch];
        let p8 = src[se + ch];
        let t: number;
        // prettier-ignore
        {
          t = p1 < p2 ? p1 : p2; p2 = p1 < p2 ? p2 : p1; p1 = t;
          t = p4 < p5 ? p4 : p5; p5 = p4 < p5 ? p5 : p4; p4 = t;
          t = p7 < p8 ? p7 : p8; p8 = p7 < p8 ? p8 : p7; p7 = t;
          t = p0 < p1 ? p0 : p1; p1 = p0 < p1 ? p1 : p0; p0 = t;
          t = p3 < p4 ? p3 : p4; p4 = p3 < p4 ? p4 : p3; p3 = t;
          t = p6 < p7 ? p6 : p7; p7 = p6 < p7 ? p7 : p6; p6 = t;
          t = p1 < p2 ? p1 : p2; p2 = p1 < p2 ? p2 : p1; p1 = t;
          t = p4 < p5 ? p4 : p5; p5 = p4 < p5 ? p5 : p4; p4 = t;
          t = p7 < p8 ? p7 : p8; p8 = p7 < p8 ? p8 : p7; p7 = t;
          t = p0 < p3 ? p0 : p3; p3 = p0 < p3 ? p3 : p0; p0 = t;
          t = p5 < p8 ? p5 : p8; p8 = p5 < p8 ? p8 : p5; p5 = t;
          t = p4 < p7 ? p4 : p7; p7 = p4 < p7 ? p7 : p4; p4 = t;
          t = p3 < p6 ? p3 : p6; p6 = p3 < p6 ? p6 : p3; p3 = t;
          t = p1 < p4 ? p1 : p4; p4 = p1 < p4 ? p4 : p1; p1 = t;
          t = p2 < p5 ? p2 : p5; p5 = p2 < p5 ? p5 : p2; p2 = t;
          t = p4 < p7 ? p4 : p7; p7 = p4 < p7 ? p7 : p4; p4 = t;
          t = p4 < p2 ? p4 : p2; p2 = p4 < p2 ? p2 : p4; p4 = t;
          t = p6 < p4 ? p6 : p4; p4 = p6 < p4 ? p4 : p6; p6 = t;
          t = p4 < p2 ? p4 : p2; p2 = p4 < p2 ? p2 : p4; p4 = t;
        }
        d[ce + ch] = p4;
      }
    }
  }
}

/**
 * Collect the colours of pixels that sit INSIDE a shape, ignoring its edges.
 *
 * A pixel only counts if the eight pixels a short step away all match it, so
 * anti-aliased edge pixels — which live in a 1-2px band between two colours —
 * can never qualify. That distinction is the whole ball game: sampling every
 * ink pixel let the navy-to-white blend along each letter claim palette slots,
 * and every slot spent on a blend became a thin sliver path traced along that
 * edge. It measured as 6 of 12 palette entries and 76% of all paths.
 */
function interiorColors(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  bg: [number, number, number],
): [number, number, number][] {
  // The probe reach and the sampling stride are both in pixels, so both scale
  // with the canvas: at 2048 an edge band is twice as wide, and a fixed stride
  // would quadruple the sample count for no extra information.
  const px = Math.max(1, Math.round(w / 1024));
  const R = 3 * px;
  const step = 2 * px;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const near = (a: number[], b: number[]) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 30;
  const out: [number, number, number][] = [];
  for (let y = R; y < h - R; y += step) {
    for (let x = R; x < w - R; x += step) {
      const c = at(x, y);
      if (
        Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) <=
        40
      ) {
        continue; // background, not ink
      }
      if (
        near(c, at(x - R, y)) &&
        near(c, at(x + R, y)) &&
        near(c, at(x, y - R)) &&
        near(c, at(x, y + R)) &&
        near(c, at(x - R, y - R)) &&
        near(c, at(x + R, y + R)) &&
        near(c, at(x - R, y + R)) &&
        near(c, at(x + R, y - R))
      ) {
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * k-means over colours, seeded farthest-first.
 *
 * The seeding is the part that matters: it hands each new centroid to the colour
 * least like anything chosen so far, so a lone purple arrow in a sea of navy
 * claims one instead of being averaged into the navy.
 */
function kMeansColors(
  sample: [number, number, number][],
  k: number,
): [number, number, number][] {
  if (!sample.length) return [];
  const cents: [number, number, number][] = [sample[0]];
  while (cents.length < k) {
    let best: [number, number, number] | null = null;
    let bestD = -1;
    for (const p of sample) {
      let m = Infinity;
      for (const c of cents) {
        const dd = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (dd < m) m = dd;
      }
      if (m > bestD) {
        bestD = m;
        best = p;
      }
    }
    if (!best || bestD <= 0) break; // fewer distinct colours than clusters
    cents.push(best);
  }
  for (let iter = 0; iter < 8; iter++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    for (const p of sample) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < cents.length; c++) {
        const dd =
          (p[0] - cents[c][0]) ** 2 +
          (p[1] - cents[c][1]) ** 2 +
          (p[2] - cents[c][2]) ** 2;
        if (dd < bd) {
          bd = dd;
          bi = c;
        }
      }
      sums[bi][0] += p[0];
      sums[bi][1] += p[1];
      sums[bi][2] += p[2];
      sums[bi][3]++;
    }
    for (let c = 0; c < cents.length; c++) {
      if (!sums[c][3]) continue;
      cents[c] = [
        Math.round(sums[c][0] / sums[c][3]),
        Math.round(sums[c][1] / sums[c][3]),
        Math.round(sums[c][2] / sums[c][3]),
      ];
    }
  }
  return cents;
}

/**
 * How badly does this artwork resist being described by a handful of flat
 * colours? Cluster the interior colours into a few groups and report how far
 * the average pixel still sits from its group. Flat art lands on ~0; smooth
 * gradients, which have no natural groups at all, land far higher. Measured
 * across a test set: flat marks 0.1, a JPEG-noisy flat mark 4.8, a rich
 * illustration 14.7, and a true gradient mark 42.6.
 */
function gradientLoad(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  bg: [number, number, number],
): number {
  const sample = interiorColors(d, w, h, bg);
  if (sample.length < 64) return 0;
  const cents = kMeansColors(sample, 6);
  if (!cents.length) return 0;
  let total = 0;
  for (const p of sample) {
    let best = Infinity;
    for (const c of cents) {
      const dd =
        Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]);
      if (dd < best) best = dd;
    }
    total += best;
  }
  return total / sample.length;
}

/**
 * Build the trace palette from the ARTWORK ONLY, skipping background pixels.
 *
 * imagetracer's own quantizer samples the whole canvas, and a logo is ~90%
 * background, so nearly every cluster it picks lands on a shade of the backdrop
 * and small accent colours get merged into whatever ink is nearest. Measured on
 * a real logo, a purple and a teal arrow both collapsed to the same grey-blue.
 *
 * Seeding farthest-first is the part that matters: it hands a centroid to the
 * colour least like anything chosen so far, so a lone purple arrow in a sea of
 * navy claims one instead of being averaged away.
 */
function inkPalette(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  bg: [number, number, number],
  k: number,
): { r: number; g: number; b: number; a: number }[] {
  let sample = interiorColors(d, w, h, bg);
  // Art too thin to have an inside (hairlines, tiny marks): fall back to every
  // ink pixel rather than tracing with a palette of nothing.
  if (sample.length < 64) {
    sample = [];
    for (let i = 0; i < d.length; i += 4 * 7) {
      const dist =
        Math.abs(d[i] - bg[0]) +
        Math.abs(d[i + 1] - bg[1]) +
        Math.abs(d[i + 2] - bg[2]);
      if (dist > 40) sample.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  const asPal = (cols: [number, number, number][]) =>
    cols.map(([r, g, b]) => ({ r, g, b, a: 255 }));
  if (!sample.length) return asPal([bg]);

  const cents = kMeansColors(sample, k);
  // k-means happily returns several near-identical centroids for one flat
  // region. Each duplicate would be traced as its own overlapping layer, so
  // collapse them and keep the palette to the colours that actually differ.
  const merged: [number, number, number][] = [];
  for (const c of cents) {
    const isNew = merged.every(
      (m) =>
        Math.abs(m[0] - c[0]) + Math.abs(m[1] - c[1]) + Math.abs(m[2] - c[2]) >=
        MERGE_DISTANCE,
    );
    if (isNew) merged.push(c);
  }
  return asPal([bg, ...merged]);
}

/**
 * Minimum area, in source pixels at 1024, for a region to survive as its own
 * shape. Anything smaller is a compression artifact or a stray anti-aliased
 * island, never a piece of the mark: an 8x8 blob is invisible on a logo but
 * costs a full path. Measured over the test set, dissolving below this cut the
 * average path count from 233 to 43 and the average file from 51KB to 19KB
 * while fidelity stayed flat (3.39 -> 3.34 mean error), so it is buying
 * cleanliness for free rather than trading detail away.
 */
const MIN_REGION_AREA = 64;

/**
 * Hard-assign every pixel to its nearest palette entry.
 *
 * Without this the tracer is handed a continuous ramp and asked to find a
 * boundary in it, so it carves the anti-aliased band along every edge into
 * micro-slivers. Posterizing first means it only ever sees flat plateaus with a
 * clean step between them, which is the shape a logo actually has.
 */
function posterize(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  pal: { r: number; g: number; b: number; a: number }[],
): Uint8Array {
  const idx = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < pal.length; k++) {
      const dd =
        Math.abs(pal[k].r - d[i]) +
        Math.abs(pal[k].g - d[i + 1]) +
        Math.abs(pal[k].b - d[i + 2]);
      if (dd < bestD) {
        bestD = dd;
        best = k;
      }
    }
    idx[p] = best;
  }
  return idx;
}

/**
 * Dissolve every connected region below `minArea` into the colour surrounding
 * it, so the tracer never emits a path for it in the first place.
 *
 * Filtering the traced paths instead would leave the notch behind: removing a
 * speck's path just exposes whatever was under it, and a speck sitting inside a
 * letter would punch a hole. Merging the region into its dominant neighbour
 * removes the boundary itself.
 */
function despeckle(
  idx: Uint8Array,
  w: number,
  h: number,
  minArea: number,
): void {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);
  for (let seed = 0; seed < n; seed++) {
    if (label[seed] !== -1) continue;
    const id = sizes.length;
    const col = idx[seed];
    let sp = 0;
    let size = 0;
    stack[sp++] = seed;
    label[seed] = id;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && label[p - 1] === -1 && idx[p - 1] === col) {
        label[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && label[p + 1] === -1 && idx[p + 1] === col) {
        label[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && label[p - w] === -1 && idx[p - w] === col) {
        label[p - w] = id;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && label[p + w] === -1 && idx[p + w] === col) {
        label[p + w] = id;
        stack[sp++] = p + w;
      }
    }
    sizes.push(size);
  }
  // Gather pixels only for the regions that are actually doomed, into one flat
  // array with a slot per region (a counting sort). The obvious version — a Map
  // from region id to a pixel array — costs a Map lookup on every one of the
  // canvas's 4M pixels, which measured as the single most expensive step here.
  const slotOf = new Int32Array(sizes.length).fill(-1);
  const doomedIds: number[] = [];
  for (let id = 0; id < sizes.length; id++) {
    if (sizes[id] < minArea) {
      slotOf[id] = doomedIds.length;
      doomedIds.push(id);
    }
  }
  if (!doomedIds.length) return;
  const start = new Int32Array(doomedIds.length + 1);
  for (let s = 0; s < doomedIds.length; s++) start[s + 1] = start[s] + sizes[doomedIds[s]];
  const cursor = start.slice(0, doomedIds.length);
  const flat = new Int32Array(start[doomedIds.length]);
  for (let p = 0; p < n; p++) {
    const slot = slotOf[label[p]];
    if (slot >= 0) flat[cursor[slot]++] = p;
  }
  // Smallest first: dissolving a speck can merge it into a neighbour that is
  // itself doomed, and going upward by size lets those cascade in one pass.
  const order = doomedIds
    .map((_, slot) => slot)
    .sort((a, b) => sizes[doomedIds[a]] - sizes[doomedIds[b]]);
  // Palette entries are few, so tally neighbours in a small array rather than a
  // Map: this runs once per doomed region.
  const tally = new Int32Array(256);
  for (const slot of order) {
    const from = start[slot];
    const to = start[slot + 1];
    if (to === from) continue;
    const own = idx[flat[from]];
    let touched = 0;
    for (let q = from; q < to; q++) {
      const p = flat[q];
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && idx[p - 1] !== own) {
        tally[idx[p - 1]]++;
        touched = 1;
      }
      if (x < w - 1 && idx[p + 1] !== own) {
        tally[idx[p + 1]]++;
        touched = 1;
      }
      if (y > 0 && idx[p - w] !== own) {
        tally[idx[p - w]]++;
        touched = 1;
      }
      if (y < h - 1 && idx[p + w] !== own) {
        tally[idx[p + w]]++;
        touched = 1;
      }
    }
    if (!touched) continue; // a region touching nothing else: the whole canvas
    let winner = own;
    let most = -1;
    for (let c = 0; c < 256; c++) {
      if (tally[c] > most) {
        most = tally[c];
        winner = c;
      }
      tally[c] = 0; // reset as we go, so the next region starts clean
    }
    for (let q = from; q < to; q++) idx[flat[q]] = winner;
  }
}

/** Paint a palette-index map back over the pixel buffer. */
function applyPalette(
  d: Uint8ClampedArray,
  idx: Uint8Array,
  pal: { r: number; g: number; b: number; a: number }[],
): void {
  for (let p = 0; p < idx.length; p++) {
    const c = pal[idx[p]];
    const i = p * 4;
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
    d[i + 3] = 255;
  }
}

/** RGB palette entry, as imagetracer wants it. */
type PalEntry = { r: number; g: number; b: number; a: number };

/** Stops sampled along a fitted gradient axis. */
type GradientFit = {
  dx: number;
  dy: number;
  smin: number;
  smax: number;
  stops: { t: number; rgb: [number, number, number] }[];
  /** Mean per-channel error of the fitted ramp against the real pixels. */
  resid: number;
  /** How far the colour travels end to end, as a sum of channel deltas. */
  range: number;
};

/** How many stops to sample along a gradient axis. */
const GRADIENT_STOPS = 8;
/** A fit worse than this (mean channel error) is not a gradient at all. */
const GRADIENT_RESID_MAX = 8;
/** Below this end-to-end colour travel, a "gradient" is just a flat fill. */
const GRADIENT_RANGE_MIN = 70;
/**
 * A gradient replaces the flat bands only if it describes the artwork about as
 * accurately as those bands already do. Measured across the test set, every
 * gradient that improved the render scored <= 1.07 on this ratio and every one
 * that made it worse scored >= 1.58, so the rule separates them cleanly and
 * needs no per-image tuning.
 */
const GRADIENT_GAIN = 1.15;
/** Region area (px at 1024) below which a shape cannot carry a visible ramp. */
const GRADIENT_MIN_REGION = 300;
/** Shared edge (px at 1024) before two regions are even considered one shape. */
const GRADIENT_MIN_BOUNDARY = 24;
/** Flat art never needs any of this, and the analysis is not free. */
const GRADIENT_MIN_LOAD = 2;
/** Caps so the merge search stays bounded on a busy illustration. */
const GRADIENT_MAX_SAMPLES = 240000;
const GRADIENT_MAX_PAIRS = 64;

/** Connected regions of equal palette index. */
function labelRegions(idx: Uint8Array, w: number, h: number) {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const colour: number[] = [];
  const size: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (labels[seed] !== -1) continue;
    const id = colour.length;
    const col = idx[seed];
    let sp = 0;
    let count = 0;
    stack[sp++] = seed;
    labels[seed] = id;
    while (sp) {
      const p = stack[--sp];
      count++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && labels[p - 1] === -1 && idx[p - 1] === col) {
        labels[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && labels[p + 1] === -1 && idx[p + 1] === col) {
        labels[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && labels[p - w] === -1 && idx[p - w] === col) {
        labels[p - w] = id;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && labels[p + w] === -1 && idx[p + w] === col) {
        labels[p + w] = id;
        stack[sp++] = p + w;
      }
    }
    colour.push(col);
    size.push(count);
  }
  return { labels, colour, size };
}

/**
 * Fit "colour varies along one spatial axis" to a set of pixels.
 *
 * The axis comes from a per-channel least-squares fit of colour against (x, y);
 * stacking those three gradient vectors and taking the dominant eigenvector of
 * their 2x2 scatter matrix gives the single direction colour actually travels
 * in. Stops are then the mean colour per bucket along that axis, which lets a
 * ramp that curves through colour space (violet -> blue -> teal) be represented
 * exactly rather than forced onto a straight RGB line.
 */
function fitLinearGradient(
  parts: number[][],
  orig: Uint8ClampedArray,
  w: number,
): GradientFit | null {
  let n = 0;
  for (const part of parts) n += part.length;
  if (n < 64) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  const sc = [0, 0, 0];
  const scx = [0, 0, 0];
  const scy = [0, 0, 0];
  for (const part of parts) for (const p of part) {
    const x = p % w;
    const y = (p / w) | 0;
    const i = p * 4;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    for (let c = 0; c < 3; c++) {
      const v = orig[i + c];
      sc[c] += v;
      scx[c] += v * x;
      scy[c] += v * y;
    }
  }
  const mx = sx / n;
  const my = sy / n;
  const cxx = sxx - n * mx * mx;
  const cxy = sxy - n * mx * my;
  const cyy = syy - n * my * my;
  const det = cxx * cyy - cxy * cxy;
  if (!det) return null;
  let a11 = 0,
    a12 = 0,
    a22 = 0;
  for (let c = 0; c < 3; c++) {
    const ccx = scx[c] - sc[c] * mx;
    const ccy = scy[c] - sc[c] * my;
    const b1 = (cyy * ccx - cxy * ccy) / det;
    const b2 = (cxx * ccy - cxy * ccx) / det;
    a11 += b1 * b1;
    a12 += b1 * b2;
    a22 += b2 * b2;
  }
  const tr = a11 + a22;
  const lam = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - (a11 * a22 - a12 * a12)));
  let dx: number;
  let dy: number;
  if (Math.abs(a12) > 1e-12) {
    dx = lam - a22;
    dy = a12;
  } else if (a11 >= a22) {
    dx = 1;
    dy = 0;
  } else {
    dx = 0;
    dy = 1;
  }
  const len = Math.hypot(dx, dy);
  if (!len || !isFinite(len)) return null;
  dx /= len;
  dy /= len;

  let smin = Infinity;
  let smax = -Infinity;
  for (const part of parts) for (const p of part) {
    const s = (p % w) * dx + ((p / w) | 0) * dy;
    if (s < smin) smin = s;
    if (s > smax) smax = s;
  }
  if (smax - smin < 4) return null;

  const acc = Array.from({ length: GRADIENT_STOPS }, () => [0, 0, 0, 0]);
  for (const part of parts) for (const p of part) {
    const s = ((p % w) * dx + ((p / w) | 0) * dy - smin) / (smax - smin);
    const b = Math.min(GRADIENT_STOPS - 1, Math.max(0, Math.floor(s * GRADIENT_STOPS)));
    const i = p * 4;
    acc[b][0] += orig[i];
    acc[b][1] += orig[i + 1];
    acc[b][2] += orig[i + 2];
    acc[b][3]++;
  }
  const stops: { t: number; rgb: [number, number, number] }[] = [];
  for (let b = 0; b < GRADIENT_STOPS; b++) {
    if (!acc[b][3]) continue;
    stops.push({
      t: (b + 0.5) / GRADIENT_STOPS,
      rgb: [
        Math.round(acc[b][0] / acc[b][3]),
        Math.round(acc[b][1] / acc[b][3]),
        Math.round(acc[b][2] / acc[b][3]),
      ],
    });
  }
  if (stops.length < 3) return null;
  const sample = (t: number): [number, number, number] => {
    if (t <= stops[0].t) return stops[0].rgb;
    const last = stops[stops.length - 1];
    if (t >= last.t) return last.rgb;
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k].t) {
        const u = (t - stops[k - 1].t) / (stops[k].t - stops[k - 1].t);
        return [0, 1, 2].map(
          (c) => stops[k - 1].rgb[c] + u * (stops[k].rgb[c] - stops[k - 1].rgb[c]),
        ) as [number, number, number];
      }
    }
    return last.rgb;
  };
  let resid = 0;
  for (const part of parts) for (const p of part) {
    const s = ((p % w) * dx + ((p / w) | 0) * dy - smin) / (smax - smin);
    const m = sample(s);
    const i = p * 4;
    resid +=
      (Math.abs(orig[i] - m[0]) +
        Math.abs(orig[i + 1] - m[1]) +
        Math.abs(orig[i + 2] - m[2])) /
      3;
  }
  resid /= n;
  let range = 0;
  for (const a of stops) {
    for (const b of stops) {
      range = Math.max(
        range,
        Math.abs(a.rgb[0] - b.rgb[0]) +
          Math.abs(a.rgb[1] - b.rgb[1]) +
          Math.abs(a.rgb[2] - b.rgb[2]),
      );
    }
  }
  // Thresholds are the caller's business: growing a group one region at a time
  // passes through unions that are still too flat to qualify on their own, and
  // rejecting those here would stop a long ramp from ever chaining together.
  return { dx, dy, smin, smax, stops, resid, range };
}

/**
 * Find shapes whose colour is a ramp rather than a set of flat steps.
 *
 * The search runs over CONNECTED REGIONS, not palette colours. Grouping by
 * colour pools every pixel of a shade from anywhere on the canvas, so one
 * arrow's ramp gets fitted together with unrelated shapes that happen to share
 * a band colour and the fit never converges. A gradient belongs to one shape.
 */
function findGradients(
  orig: Uint8ClampedArray,
  idx: Uint8Array,
  w: number,
  h: number,
  pal: PalEntry[],
) {
  const { labels, colour, size } = labelRegions(idx, w, h);
  const minRegion = Math.round(GRADIENT_MIN_REGION * (w / 1024) * (w / 1024));
  const big: number[] = [];
  for (let id = 0; id < size.length; id++) {
    // Index 0 is the background: it must never be pulled into a gradient.
    if (size[id] >= minRegion && colour[id] !== 0) big.push(id);
  }
  if (big.length < 2) return { groups: [], labels, regionCount: size.length };
  const isBig = new Uint8Array(size.length);
  for (const id of big) isBig[id] = 1;

  // Shared boundary length between neighbouring regions.
  const adj = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = labels[p];
      if (!isBig[a]) continue;
      if (x < w - 1) {
        const b = labels[p + 1];
        if (b !== a && isBig[b]) {
          const k = a < b ? a * 4194304 + b : b * 4194304 + a;
          adj.set(k, (adj.get(k) || 0) + 1);
        }
      }
      if (y < h - 1) {
        const b = labels[p + w];
        if (b !== a && isBig[b]) {
          const k = a < b ? a * 4194304 + b : b * 4194304 + a;
          adj.set(k, (adj.get(k) || 0) + 1);
        }
      }
    }
  }

  const samples = new Map<number, number[]>();
  for (const id of big) samples.set(id, []);
  const stride = Math.max(1, Math.floor((w * h) / GRADIENT_MAX_SAMPLES));
  for (let p = 0; p < w * h; p += stride) {
    const bucket = samples.get(labels[p]);
    if (bucket) bucket.push(p);
  }

  const parent = new Map(big.map((id) => [id, id]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(i) !== r) {
      const next = parent.get(i)!;
      parent.set(i, r);
      i = next;
    }
    return r;
  };
  // One live pixel array per group root, appended in place on a merge. Rebuilding
  // the union for every candidate pair (and spreading it into a new array) was
  // the single slowest thing in the export.
  const groupPixels = new Map<number, number[]>();
  for (const id of big) groupPixels.set(id, samples.get(id)!);

  const minBoundary = Math.round(GRADIENT_MIN_BOUNDARY * (w / 1024));
  const pairs: [number, number, number][] = [];
  for (const [k, v] of adj) {
    if (v >= minBoundary) pairs.push([Math.floor(k / 4194304), k % 4194304, v]);
  }
  pairs.sort((a, b) => b[2] - a[2]);
  for (const [a, b] of pairs.slice(0, GRADIENT_MAX_PAIRS)) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const pa = groupPixels.get(ra)!;
    const pb = groupPixels.get(rb)!;
    const fit = fitLinearGradient([pa, pb], orig, w);
    // Growing the group only needs the ramp to still describe the union well;
    // whether it is worth drawing as a gradient is judged once, at the end.
    if (fit && fit.resid < GRADIENT_RESID_MAX) {
      parent.set(rb, ra);
      for (const p of pb) pa.push(p);
      groupPixels.delete(rb);
    }
  }

  const groups: { members: number[]; fit: GradientFit }[] = [];
  const seen = new Set<number>();
  for (const id of big) {
    const root = find(id);
    if (seen.has(root)) continue;
    seen.add(root);
    const members = big.filter((x) => find(x) === root);
    if (members.length < 2) continue;
    // Two regions of the SAME colour are not a ramp, however adjacent.
    if (new Set(members.map((m) => colour[m])).size < 2) continue;
    const pixels = groupPixels.get(root)!;
    const fit = fitLinearGradient([pixels], orig, w);
    if (!fit || fit.resid >= GRADIENT_RESID_MAX || fit.range < GRADIENT_RANGE_MIN) {
      continue;
    }
    // What error do the flat bands already achieve on these same pixels?
    let band = 0;
    for (const p of pixels) {
      const c = pal[idx[p]];
      const i = p * 4;
      band +=
        (Math.abs(orig[i] - c.r) +
          Math.abs(orig[i + 1] - c.g) +
          Math.abs(orig[i + 2] - c.b)) /
        3;
    }
    band /= pixels.length;
    if (band > 0.01 && fit.resid > band * GRADIENT_GAIN) continue;
    groups.push({ members, fit });
  }
  return { groups, labels, regionCount: size.length };
}

/**
 * Tidy imagetracer's raw output into a file a designer can open without
 * flinching.
 *
 * It emits one <path> per traced region, each carrying a redundant zero-width
 * stroke, an opacity of 1, and a `desc` attribute that isn't valid SVG — so a
 * simple mark arrives as dozens of elements with nothing to distinguish them.
 * Consecutive paths that share a fill are disjoint pieces of one colour layer
 * (imagetracer emits a layer at a time, and holes already live inside their own
 * path's `d`), so concatenating their subpaths is safe under the default
 * nonzero fill rule and collapses the file to roughly one element per colour.
 */
function tidySvg(svg: string): string {
  const runs: { fill: string; d: string[] }[] = [];
  // A NUL sentinel, never a space: the <svg> header is full of spaces, so
  // splicing on one would cut the document in the wrong place.
  const MARK = "\u0000";
  const body = svg.replace(
    /<path\b[^>]*?fill="([^"]*)"[^>]*?\bd="([^"]*)"[^>]*?\/>/g,
    (_m, fill: string, d: string) => {
      const last = runs[runs.length - 1];
      if (last && last.fill === fill) last.d.push(d.trim());
      else runs.push({ fill, d: [d.trim()] });
      return MARK;
    },
  );
  if (!runs.length) return svg;
  const merged = runs
    .map((r) => `<path fill="${r.fill}" d="${r.d.join(" ")}"/>`)
    .join("");
  // Splice the merged paths in where the first traced path stood, so the <svg>
  // header and closing tag keep their places, then clear the other sentinels.
  return body
    .replace(MARK, merged)
    .split(MARK)
    .join("")
    .replace(/ desc="[^"]*"/, "");
}

/**
 * For key-out tracing: a chroma key the artwork itself doesn't use, so the
 * background layer can be stripped from the traced SVG without ever touching
 * an ink color. Sampled against the actual pixels; the candidate furthest
 * from every color in the artwork wins.
 */
function pickKeyColor(
  d: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] {
  const candidates: [number, number, number][] = [
    [255, 0, 255],
    [0, 255, 0],
    [0, 255, 255],
    [255, 128, 0],
  ];
  let best = candidates[0];
  let bestScore = -1;
  for (const cand of candidates) {
    let minDist = Infinity;
    for (let p = 0; p < w * h; p += 7) {
      if (d[p * 4 + 3] < 24) continue; // transparent: not artwork
      const dist =
        Math.abs(d[p * 4] - cand[0]) +
        Math.abs(d[p * 4 + 1] - cand[1]) +
        Math.abs(d[p * 4 + 2] - cand[2]);
      if (dist < minDist) minDist = dist;
    }
    if (minDist > bestScore) {
      bestScore = minDist;
      best = cand;
    }
  }
  return best;
}

export async function logoToSvgString(
  src: string,
  opts: { keyOut?: boolean } = {},
): Promise<string> {
  // Lazy-loaded: imagetracerjs is ~3.2MB and only needed on an SVG export click,
  // so it stays out of the first-load bundle.
  const { default: ImageTracer } = await import("imagetracerjs");
  const img = await loadImage(src);
  // Not const: gradient-heavy art gets traced at 2x, which reassigns these.
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");

  let key: [number, number, number] | null = null;
  if (opts.keyOut) {
    // Transparent-input path (the brand kit's cutout): flatten onto a chroma
    // key instead of white, trace, then strip the key-colored layers so the
    // SVG ships with a genuinely transparent background and real counter
    // holes instead of a baked backdrop.
    ctx.drawImage(img, 0, 0, w, h);
    const raw = ctx.getImageData(0, 0, w, h);
    key = pickKeyColor(raw.data, w, h);
    // Hard-edge the alpha so anti-aliased half-pixels don't blend with the
    // key and leave a tinted fringe for the tracer to keep.
    const rd = raw.data;
    for (let i = 3; i < rd.length; i += 4) rd[i] = rd[i] < 140 ? 0 : 255;
    ctx.putImageData(raw, 0, 0);
    const flat = document.createElement("canvas");
    flat.width = w;
    flat.height = h;
    const fctx = flat.getContext("2d", { willReadFrequently: true })!;
    fctx.fillStyle = `rgb(${key[0]},${key[1]},${key[2]})`;
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(flat, 0, 0);
  } else {
    // Opaque white base so transparent inputs flatten cleanly.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  }
  // Denoise before anything reads colours off the image, so neither the
  // background test nor the palette sees JPEG ringing.
  const pre = ctx.getImageData(0, 0, w, h);
  denoise(pre.data, w, h);
  ctx.putImageData(pre, 0, 0);

  let bg = flattenBackground(ctx, w, h);

  // Smooth-gradient artwork is the one case flat-fill tracing handles badly: it
  // has to approximate a continuous ramp as bands, and at 1:1 the bands land far
  // enough apart to see. Tracing such a logo at 2x halves that step and measured
  // 10.1 -> 4.5 error on a gradient mark. It is NOT a free win, so it stays
  // conditional: on flat art the same change bloated a 6 KB icon to 152 KB and
  // tripled the time for no gain.
  let scale = 1;
  // Measured once: it decides both the supersample below and whether the
  // gradient search later is worth running at all.
  const load = gradientLoad(ctx.getImageData(0, 0, w, h).data, w, h, bg);
  // Only worth doing on a small source. Logos now generate at 2048, which
  // already has the detail supersampling was buying, and doubling again would
  // put the trace at 4096 and ~17s.
  if (w < 1536 && load > 25) {
    scale = 2;
    const big = document.createElement("canvas");
    big.width = w * scale;
    big.height = h * scale;
    const bctx = big.getContext("2d", { willReadFrequently: true })!;
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(canvas, 0, 0, big.width, big.height);
    canvas.width = big.width;
    canvas.height = big.height;
    ctx.drawImage(big, 0, 0);
    w = big.width;
    h = big.height;
    bg = flattenBackground(ctx, w, h);
  }

  const imgdata = ctx.getImageData(0, 0, w, h);
  // Every pixel-denominated threshold below was tuned against a 1024px canvas,
  // so they have to track whatever we are actually tracing.
  const px = Math.max(1, w / 1024);
  // An explicit palette; without it imagetracer quantizes against the mostly
  // empty canvas and drops the accent colours.
  const pal = inkPalette(imgdata.data, w, h, bg, INK_CLUSTERS);
  // Flatten to that palette and dissolve the specks BEFORE tracing, so the
  // tracer is handed clean plateaus instead of an anti-aliased ramp it would
  // otherwise carve into micro-slivers. MIN_REGION_AREA is an area, so it grows
  // with the square of the scale factor.
  const idx = posterize(imgdata.data, w, h, pal);
  despeckle(idx, w, h, Math.round(MIN_REGION_AREA * px * px));

  // Where the artwork is genuinely a ramp, trace it as ONE shape and fill it
  // with a real <linearGradient> instead of a stack of flat bands. Posterizing
  // made those bands crisp, which is exactly what makes banding visible; a
  // gradient removes the steps rather than hiding them. Flat art skips this
  // entirely, both because it cannot benefit and because the search is not free.
  // NOTE: this runs BEFORE applyPalette, while imgdata still holds the original
  // colours the gradient has to be fitted to.
  const gradients =
    load >= GRADIENT_MIN_LOAD
      ? findGradients(imgdata.data, idx, w, h, pal)
      : { groups: [], labels: null, regionCount: 0 };
  const tracePal: PalEntry[] = pal.map((c) => ({ ...c }));
  const marks: [number, number, number][] = [];
  if (gradients.groups.length && gradients.labels) {
    const labels = gradients.labels;
    // One lookup from region id to its gradient's palette slot, so every pixel
    // is rewritten in a single pass instead of one full scan per gradient.
    const markOf = new Int32Array(gradients.regionCount).fill(-1);
    for (const group of gradients.groups) {
      // Each gradient needs a colour of its own so the traced fill can be
      // swapped for a url(#..) reference with no ambiguity. Any colour will do
      // as long as nothing else in the palette is near it.
      // Keep well clear of every palette colour - 96 in particular, because the
      // key-out path strips any path whose fill is within 96 of the chroma key,
      // and the key is a palette entry. A marker that landed inside that radius
      // would silently delete the whole gradient shape from a brand-kit SVG.
      let mark: [number, number, number] | null = null;
      for (let v = 0; v < 512 && !mark; v++) {
        // A coarse spread through the colour cube; a multiply-and-wrap sequence
        // looks varied but repeats every 256 steps in all three channels at once.
        const cand: [number, number, number] = [
          (v % 8) * 36,
          ((v >> 3) % 8) * 36,
          ((v >> 6) % 8) * 36,
        ];
        const clear = tracePal.every(
          (q) =>
            Math.abs(q.r - cand[0]) + Math.abs(q.g - cand[1]) + Math.abs(q.b - cand[2]) > 128,
        );
        if (clear) mark = cand;
      }
      if (!mark) break; // palette too crowded to key a gradient safely
      marks.push(mark);
      tracePal.push({ r: mark[0], g: mark[1], b: mark[2], a: 255 });
      const markIdx = tracePal.length - 1;
      for (const region of group.members) markOf[region] = markIdx;
    }
    if (marks.length) {
      for (let p = 0; p < w * h; p++) {
        const m = markOf[labels[p]];
        if (m >= 0) idx[p] = m;
      }
    }
  }

  // Drop palette entries nothing uses any more. imagetracer traces one layer per
  // entry across the whole canvas, so an unused colour costs a full pass for
  // nothing - and folding a gradient's bands into one marker colour is exactly
  // what strands them. On a 13-colour gradient logo this roughly halves the
  // palette and, with it, the trace.
  const used = new Uint8Array(tracePal.length);
  for (let p = 0; p < w * h; p++) used[idx[p]] = 1;
  let live = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) live++;
  if (live < tracePal.length) {
    const remap = new Uint8Array(tracePal.length);
    const compact: PalEntry[] = [];
    for (let i = 0; i < tracePal.length; i++) {
      if (!used[i]) continue;
      remap[i] = compact.length;
      compact.push(tracePal[i]);
    }
    for (let p = 0; p < w * h; p++) idx[p] = remap[idx[p]];
    tracePal.length = 0;
    tracePal.push(...compact);
  }
  applyPalette(imgdata.data, idx, tracePal);
  let svg: string = ImageTracer.imagedataToSVG(imgdata, {
    ...LOGO_TRACE_OPTS,
    // Speck threshold is in pixels, so it has to track the traced resolution.
    pathomit: Math.round(LOGO_TRACE_OPTS.pathomit * px),
    ltres: LOGO_TRACE_OPTS.ltres * px,
    qtres: LOGO_TRACE_OPTS.qtres * px,
    // imagetracer MUTATES the palette array it is handed, so pass it a copy and
    // keep ours intact for anything downstream.
    pal: tracePal.map((c) => ({ ...c })),
  });
  if (key) {
    const [kr, kg, kb] = key;
    svg = svg.replace(/<path\b[^>]*\/>/g, (tag) => {
      const m = tag.match(/fill="rgb\((\d+),\s*(\d+),\s*(\d+)\)"/);
      if (!m) return tag;
      const dist =
        Math.abs(+m[1] - kr) + Math.abs(+m[2] - kg) + Math.abs(+m[3] - kb);
      return dist < 96 ? "" : tag;
    });
  }
  svg = tidySvg(svg);
  // Swap each gradient's stand-in colour for its <linearGradient>. Done after
  // tidySvg so the group is already one <path> per gradient.
  if (marks.length) {
    const defs = gradients.groups
      .slice(0, marks.length)
      .map((group, k) => {
        const f = group.fit;
        const stops = f.stops
          .map(
            (s) =>
              `<stop offset="${(s.t * 100).toFixed(1)}%" stop-color="rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})"/>`,
          )
          .join("");
        // userSpaceOnUse with the axis endpoints in image coordinates: the
        // gradient then lands exactly where it was measured, whatever the shape's
        // own bounding box happens to be.
        return `<linearGradient id="lg${k}" gradientUnits="userSpaceOnUse" x1="${(f.dx * f.smin).toFixed(1)}" y1="${(f.dy * f.smin).toFixed(1)}" x2="${(f.dx * f.smax).toFixed(1)}" y2="${(f.dy * f.smax).toFixed(1)}">${stops}</linearGradient>`;
      })
      .join("");
    svg = svg.replace(/(<svg[^>]*>)/, `$1<defs>${defs}</defs>`);
    marks.forEach((m, k) => {
      svg = svg.split(`fill="rgb(${m[0]},${m[1]},${m[2]})"`).join(`fill="url(#lg${k})"`);
    });
  }
  return svg;
}

export async function logoToSvgBlob(
  src: string,
  opts: { keyOut?: boolean } = {},
): Promise<Blob> {
  const svg = await logoToSvgString(src, opts);
  return new Blob([svg], { type: "image/svg+xml" });
}

/**
 * Rasterize the (vectorized) logo to a clean square PNG at an arbitrary size.
 * Tracing to SVG first means 2048/4096 come out genuinely sharp for these flat
 * marks instead of an upscaled blur. The traced SVG is viewBox-only so it
 * scales in the DOM, but canvas rasterization needs explicit intrinsic
 * dimensions or some browsers draw nothing - so we inject width/height = size.
 */
export async function logoToHiResPngBlob(
  src: string,
  size: number,
): Promise<Blob> {
  const svg = (await logoToSvgString(src)).replace(
    /<svg([^>]*?)>/,
    (_m, attrs: string) =>
      `<svg${attrs.replace(
        /\s(?:width|height)="[^"]*"/g,
        "",
      )} width="${size}" height="${size}">`,
  );
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, size, size);
  return canvasToBlob(canvas);
}
