// One picture from inside a PDF -> a JPEG for each compression level.
// Runs in a worker (js/pdfimage-worker.js) so several pictures are processed at once on all CPU cores,
// or on the main thread as a fallback. Needs no DOM: OffscreenCanvas when available, else a <canvas>.
import { CDN } from "./config.js";

export const MOZJPEG = "https://cdn.jsdelivr.net/npm/@jsquash/jpeg@1.6.0/encode.js";
export const jpegOptions = (q) => ({ quality: Math.round(q), progressive: true, optimize_coding: true, trellis_multipass: q >= 85, chroma_subsample: q >= 90 ? 1 : 2 });

let pakoP, mozP;
const pako = () => (pakoP ||= import(CDN.pako).then((m) => m.default || m));
const mozjpeg = () => (mozP ||= import(MOZJPEG).then((m) => m.default).catch((e) => { mozP = null; throw e; }));

/** PNG predictor (DecodeParms /Predictor >= 10) undo */
export function unpredict(data, colors, columns, bpc = 8) {
  const bpp = Math.max(1, (colors * bpc) >> 3), row = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (row + 1)), out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (row + 1)], si = r * (row + 1) + 1, di = r * row;
    for (let i = 0; i < row; i++) {
      const raw = data[si + i], a = i >= bpp ? out[di + i - bpp] : 0, b = r ? out[di - row + i] : 0, c = r && i >= bpp ? out[di - row + i - bpp] : 0;
      let v;
      if (f === 0) v = raw; else if (f === 1) v = raw + a; else if (f === 2) v = raw + b; else if (f === 3) v = raw + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[di + i] = v & 255;
    }
  }
  return out;
}

/** Raw samples -> RGBA ImageData (bit depth 1/2/4/8; gray, rgb, cmyk or indexed). cs = { n, palette? } */
export function toImageData(px, w, h, bpc, cs) {
  const n = cs.n, rowBytes = Math.ceil((w * n * bpc) / 8), max = (1 << bpc) - 1;
  if (px.length < rowBytes * h) return null;
  const id = new ImageData(w, h), p = id.data;
  if (bpc === 8 && !cs.palette && n === 3) {            // the common case, without per-sample branching
    for (let i = 0, o = 0, len = w * h * 3; i < len; i += 3, o += 4) { p[o] = px[i]; p[o + 1] = px[i + 1]; p[o + 2] = px[i + 2]; p[o + 3] = 255; }
    return id;
  }
  if (bpc === 8 && !cs.palette && n === 1) {
    for (let i = 0, o = 0, len = w * h; i < len; i++, o += 4) { const v = px[i]; p[o] = p[o + 1] = p[o + 2] = v; p[o + 3] = 255; }
    return id;
  }
  const sample = (row, i) => { if (bpc === 8) return px[row + i]; const bit = i * bpc, byte = px[row + (bit >> 3)]; return (byte >> (8 - bpc - (bit & 7))) & max; };
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4; let r, g, b;
      if (cs.palette) {
        const idx = Math.min(sample(row, x), cs.palette.hival), bn = cs.palette.base, t = cs.palette.table, j = idx * bn;
        if (bn === 1) r = g = b = t[j]; else if (bn === 3) { r = t[j]; g = t[j + 1]; b = t[j + 2]; }
        else { const k = 1 - t[j + 3] / 255; r = 255 * (1 - t[j] / 255) * k; g = 255 * (1 - t[j + 1] / 255) * k; b = 255 * (1 - t[j + 2] / 255) * k; }
      } else if (n === 1) r = g = b = (sample(row, x) * 255) / max;
      else if (n === 3) { r = (sample(row, x * 3) * 255) / max; g = (sample(row, x * 3 + 1) * 255) / max; b = (sample(row, x * 3 + 2) * 255) / max; }
      else { const c = sample(row, x * 4) / max, m = sample(row, x * 4 + 1) / max, yy = sample(row, x * 4 + 2) / max, k = 1 - sample(row, x * 4 + 3) / max; r = 255 * (1 - c) * k; g = 255 * (1 - m) * k; b = 255 * (1 - yy) * k; }
      p[o] = r; p[o + 1] = g; p[o + 2] = b; p[o + 3] = 255;
    }
  }
  return id;
}

const makeCanvas = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));

async function encode(canvas, g, q) {
  try {
    const enc = await mozjpeg();
    return new Uint8Array(await enc(g.getImageData(0, 0, canvas.width, canvas.height), jpegOptions(q)));
  } catch (e) {                                                    // MozJPEG unavailable: the browser's encoder
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/jpeg", quality: q / 100 })
      : await new Promise((r) => canvas.toBlob(r, "image/jpeg", q / 100));
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/**
 * job: { raw: Uint8Array, kind: "jpeg" | "flate" | "plain", w, h, bpc, cs, pred: { predictor, colors, columns },
 *        levels: [{ key, maxDim, q }] }
 * -> { [key]: { jpg, w, h } } or null if the picture can't be decoded.
 */
export async function processImage(job) {
  const { w, h, bpc, cs } = job;
  let source;
  if (job.kind === "jpeg") source = await createImageBitmap(new Blob([job.raw], { type: "image/jpeg" }));
  else {
    let px = job.kind === "flate" ? (await pako()).inflate(job.raw) : job.raw;
    if (job.pred.predictor >= 10) px = unpredict(px, job.pred.colors || cs.n, job.pred.columns || w, bpc);
    const id = toImageData(px, w, h, bpc, cs);
    if (!id) return null;
    source = await createImageBitmap(id);
  }
  const out = {};
  try {
    for (const L of job.levels) {
      const k = Math.min(1, L.maxDim / Math.max(w, h));
      const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
      const c = makeCanvas(nw, nh), g = c.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "#fff"; g.fillRect(0, 0, nw, nh); g.imageSmoothingQuality = "high"; g.drawImage(source, 0, 0, nw, nh);
      out[L.key] = { jpg: await encode(c, g, L.q), w: nw, h: nh };
    }
  } finally { source.close?.(); }
  return out;
}
