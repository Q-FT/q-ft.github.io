// Better encoders than the browser's built-in ones:
// - JPEG: MozJPEG (Apache-2.0, via @jsquash/jpeg). Same visual quality, noticeably smaller files.
// - PNG: UPNG.js (MIT). Lossless re-compression, or 256-color quantization (TinyPNG style) that keeps transparency.
// Both fall back to canvas encoding if the wasm can't load.
import { CDN } from "./config.js";

const MOZJPEG = "https://cdn.jsdelivr.net/npm/@jsquash/jpeg@1.6.0/encode.js";
const UPNG = "https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js";

const pixels = (src) => {
  if (src instanceof ImageData) return src;
  const g = src.getContext("2d", { willReadFrequently: true });
  return g.getImageData(0, 0, src.width, src.height);
};
const canvasBlob = (c, type, q) => new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("Couldn't encode the image"))), type, q));
const toCanvas = (id) => { const c = Object.assign(document.createElement("canvas"), { width: id.width, height: id.height }); c.getContext("2d").putImageData(id, 0, 0); return c; };

let mozP;
/** JPEG at quality 0-100. `src` is a canvas or ImageData (transparent areas should already be flattened). */
export async function encodeJpeg(src, quality = 82) {
  const id = pixels(src);
  try {
    const encode = (mozP ||= import(MOZJPEG).then((m) => m.default));
    const buf = await (await encode)(id, { quality: Math.round(quality), progressive: true, optimize_coding: true, trellis_multipass: quality >= 85, chroma_subsample: quality >= 90 ? 1 : 2 });
    return new Blob([buf], { type: "image/jpeg" });
  } catch (e) {
    console.warn("MozJPEG unavailable, using the browser encoder", e); mozP = null;
    return canvasBlob(src instanceof ImageData ? toCanvas(src) : src, "image/jpeg", quality / 100);
  }
}

let upngP;
const upng = () => (upngP ||= (async () => {
  const pako = await import(CDN.pako); window.pako = pako.default || pako;
  await new Promise((r, j) => document.head.appendChild(Object.assign(document.createElement("script"), { src: UPNG, onload: r, onerror: () => { upngP = null; j(new Error("PNG optimizer failed to load")); } })));
  return window.UPNG;
})());

/** PNG. colors = 0 for lossless, or 256/128/64 for palette quantization. */
export async function encodePng(src, colors = 0) {
  const id = pixels(src);
  try {
    const U = await upng();
    return new Blob([U.encode([id.data.buffer.slice(0)], id.width, id.height, colors)], { type: "image/png" });
  } catch (e) {
    console.warn("UPNG unavailable, using the browser encoder", e);
    return canvasBlob(src instanceof ImageData ? toCanvas(src) : src, "image/png");
  }
}

/** Does the image use transparency? Is it a photo (many colors) or a graphic/screenshot? (sampled, fast) */
export function analyze(src) {
  const { data, width, height } = pixels(src), step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  let alpha = false; const colors = new Set();
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4; if (data[i + 3] < 250) alpha = true;
    if (colors.size < 6000) colors.add((data[i] >> 2) << 12 | (data[i + 1] >> 2) << 6 | (data[i + 2] >> 2));
  }
  return { alpha, photo: colors.size >= 2500 };
}
