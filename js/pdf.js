// Compress PDF: recompress the pictures inside the PDF (text and vector drawings untouched), deflate
// uncompressed streams, and repack the file with object streams. Runs fully in the browser with pdf-lib.
import { CDN } from "./config.js";
import { esc, fmtBytes, baseName, dropzone, segmented, opt, jobRow, button, download, downloadZip } from "./ui.js";

// keep: only swap a picture when the new one is at most this fraction of the old size
const LEVELS = {
  light: { maxDim: 2400, q: 0.8, keep: 0.95, label: "Light" },
  balanced: { maxDim: 1600, q: 0.62, keep: 0.97, label: "Recommended" },
  strong: { maxDim: 1050, q: 0.42, keep: 0.99, label: "Strong" },
  extreme: { dpi: 96, q: 0.5, label: "Extreme" },
};

let libsP;
const libs = () => (libsP ||= Promise.all([import(CDN.pdfLib), import(CDN.pako)]).then(([pdf, pako]) => ({ ...pdf, pako: pako.default || pako })));

/** PNG predictor (DecodeParms /Predictor >= 10) undo, in place into a new buffer */
function unpredict(data, colors, columns, bpc = 8) {
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

const toBlob = (c, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", q));

export async function compressPdf(bytes, levelKey, onProgress = () => {}) {
  const { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict, PDFBool, pako } = await libs();
  const level = LEVELS[levelKey];
  if (level.dpi) { // extreme: every page becomes one JPEG (text is no longer selectable)
    const { rasterize } = await import("./pdftools.js");
    const out = await rasterize(bytes, level.dpi, level.q, onProgress);
    return { bytes: out.length < bytes.length ? out : bytes, images: 0, changed: 0, skipped: 0, smaller: out.length < bytes.length, flattened: true };
  }
  let doc;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypt/i.test(e.message) ? "This PDF is password-protected. Unlock it first." : "This file couldn't be read as a PDF."); }
  const ctx = doc.context, N = (n) => PDFName.of(n);
  const look = (v) => (v ? ctx.lookup(v) : v);
  const num = (v) => { v = look(v); return v instanceof PDFNumber ? v.asNumber() : undefined; };
  const filtersOf = (dict) => { const f = look(dict.get(N("Filter"))); return !f ? [] : f instanceof PDFArray ? f.asArray().map((x) => look(x).asString?.() ?? String(look(x))) : [f.asString?.() ?? String(f)]; };
  const streamBytes = (o) => { const f = filtersOf(o.dict); const b = o.getContents(); return !f.length ? b : f.length === 1 && f[0] === "/FlateDecode" ? pako.inflate(b) : null; };
  /** Color space -> { n: components (1 gray, 3 rgb, 4 cmyk), palette? } or null when unsupported (Lab, Separation…) */
  const colorSpace = (cs) => {
    cs = look(cs);
    if (!cs) return null;
    const name = cs instanceof PDFArray ? String(look(cs.get(0))) : String(cs);
    if (name === "/DeviceRGB" || name === "/CalRGB") return { n: 3 };
    if (name === "/DeviceGray" || name === "/CalGray") return { n: 1 };
    if (name === "/DeviceCMYK") return { n: 4 };
    if (name === "/ICCBased" && cs instanceof PDFArray) { const n = num(look(cs.get(1)).dict?.get(N("N"))); return n === 1 || n === 3 || n === 4 ? { n } : null; }
    if (name === "/Indexed" && cs instanceof PDFArray) {
      const base = colorSpace(cs.get(1)), hival = num(cs.get(2)), lk = look(cs.get(3));
      const table = lk instanceof PDFRawStream ? streamBytes(lk) : lk?.asBytes?.();
      return base && !base.palette && table ? { n: 1, palette: { base: base.n, hival, table } } : null;
    }
    return null;
  };
  /** Raw samples -> RGBA ImageData (any bit depth 1/2/4/8, gray/rgb/cmyk/indexed) */
  const toImageData = (px, w, h, bpc, cs) => {
    const n = cs.n, rowBytes = Math.ceil((w * n * bpc) / 8), id = new ImageData(w, h), p = id.data, max = (1 << bpc) - 1;
    if (px.length < rowBytes * h) return null;
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
  };

  const all = ctx.enumerateIndirectObjects();
  const images = all.filter(([, o]) => o instanceof PDFRawStream && String(o.dict.get(N("Subtype"))) === "/Image");
  let done = 0, changed = 0, skipped = 0;
  for (const [ref, obj] of images) {
    onProgress(0.05 + 0.85 * (done++ / Math.max(1, images.length)));
    try {
      const d = obj.dict;
      if (look(d.get(N("ImageMask"))) === PDFBool.True) continue;
      const w = num(d.get(N("Width"))), h = num(d.get(N("Height"))), bpc = num(d.get(N("BitsPerComponent"))) || 8;
      const cs = colorSpace(d.get(N("ColorSpace"))), filters = filtersOf(d), raw = obj.getContents();
      if (!w || !h || w * h < 4096 || !cs || d.get(N("Decode")) || d.get(N("SMaskInData")) || ![1, 2, 4, 8].includes(bpc)) { skipped++; continue; }
      let source;
      if (filters.length === 1 && filters[0] === "/DCTDecode" && (cs.n === 3 || cs.n === 1) && !cs.palette) {
        source = await createImageBitmap(new Blob([raw], { type: "image/jpeg" }));
      } else if (filters.length <= 1 && (!filters.length || filters[0] === "/FlateDecode")) {
        let px = filters.length ? pako.inflate(raw) : raw;
        const parms = look(d.get(N("DecodeParms")));
        const pred = parms instanceof PDFDict ? num(parms.get(N("Predictor"))) || 1 : 1;
        if (pred >= 10) px = unpredict(px, num(parms.get(N("Colors"))) || cs.n, num(parms.get(N("Columns"))) || w, bpc);
        else if (pred !== 1) { skipped++; continue; }
        const id = toImageData(px, w, h, bpc, cs); if (!id) { skipped++; continue; }
        source = await createImageBitmap(id);
      } else { skipped++; continue; } // JPEG 2000, JBIG2, CCITT: already compact formats

      const k = Math.min(1, level.maxDim / Math.max(w, h));
      const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
      const c = Object.assign(document.createElement("canvas"), { width: nw, height: nh }), g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, nw, nh); g.imageSmoothingQuality = "high"; g.drawImage(source, 0, 0, nw, nh); source.close?.();
      const jpg = new Uint8Array(await (await toBlob(c, level.q)).arrayBuffer());
      if (jpg.length > raw.length * level.keep) continue; // not worth it: keep the original picture
      const nd = d.clone(ctx);
      for (const key of ["Filter", "DecodeParms", "Decode", "Length", "BitsPerComponent", "ColorSpace", "Width", "Height"]) nd.delete(N(key));
      nd.set(N("Filter"), N("DCTDecode")); nd.set(N("ColorSpace"), N("DeviceRGB")); nd.set(N("BitsPerComponent"), PDFNumber.of(8));
      nd.set(N("Width"), PDFNumber.of(nw)); nd.set(N("Height"), PDFNumber.of(nh)); nd.set(N("Length"), PDFNumber.of(jpg.length));
      ctx.assign(ref, PDFRawStream.of(nd, jpg));
      changed++;
    } catch (e) { console.warn("image skipped", e); }
  }

  // deflate streams that were stored uncompressed (fonts, page content), except XMP metadata
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(N("Filter")) || String(obj.dict.get(N("Type"))) === "/Metadata") continue;
    const raw = obj.getContents(); if (raw.length < 256) continue;
    const z = pako.deflate(raw, { level: 9 }); if (z.length > raw.length * 0.9) continue;
    const nd = obj.dict.clone(ctx); nd.set(N("Filter"), N("FlateDecode")); nd.set(N("Length"), PDFNumber.of(z.length));
    ctx.assign(ref, PDFRawStream.of(nd, z));
  }
  onProgress(0.95);
  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  onProgress(1);
  return { bytes: out.length < bytes.length ? out : bytes, images: images.length, changed, skipped, smaller: out.length < bytes.length };
}

export function mount(panel) {
  let level = "balanced";
  const results = [];
  const opts = document.createElement("div"); opts.className = "opts";
  opts.append(opt("Compression", segmented(Object.entries(LEVELS).map(([k, v]) => [k, v.label]), level, (v) => (level = v))));
  const hint = document.createElement("p"); hint.className = "hint";
  hint.textContent = "Light, Recommended and Strong shrink the pictures and keep text crisp and selectable. Extreme turns every page into an image: the smallest file, but text can no longer be selected or searched.";
  const jobs = document.createElement("div"); jobs.className = "jobs";
  const tail = document.createElement("div"); tail.className = "row-end"; tail.hidden = true;
  tail.append(button("Download all (.zip)", "btn btn--primary", () => downloadZip(results, "q-ft-compressed-pdfs.zip")));
  panel.append(dropzone({ accept: "application/pdf,.pdf", multiple: true, title: "Drop PDFs here or click to choose", sub: "Files stay on your device", onFiles: add }), opts, hint, jobs, tail);

  let chain = Promise.resolve();
  function add(files) {
    for (const f of files) {
      const row = jobRow(f.name, "PDF"); row.meta(`${fmtBytes(f.size)} · waiting`); row.progress(0); jobs.appendChild(row.el);
      const lv = level;
      chain = chain.then(() => run(f, row, lv));
    }
  }
  async function run(f, row, lv) {
    try {
      row.meta(`${fmtBytes(f.size)} · compressing…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await compressPdf(bytes, lv, (p) => row.progress(p));
      row.progress(null);
      const blob = new Blob([r.bytes], { type: "application/pdf" }), name = `${baseName(f.name)}_compressed.pdf`;
      const saved = 1 - r.bytes.length / bytes.length;
      const detail = r.flattened ? "pages flattened to images" : r.images ? `${r.changed} of ${r.images} pictures shrunk` : "no pictures inside, structure optimized";
      row.meta(r.smaller && saved > 0.005
        ? `${fmtBytes(f.size)} → <b>${fmtBytes(blob.size)}</b> · <span class="ok">${Math.round(saved * 100)}% smaller</span> · ${LEVELS[lv].label} · ${detail}`
        : `${fmtBytes(f.size)} · already well optimized (${detail})${lv !== "extreme" ? ". Try Extreme for the smallest file." : ""}`);
      results.push({ name, blob });
      row.actions(button("Download", "btn btn--primary btn--sm", () => download(blob, name)));
      tail.hidden = results.length < 2;
    } catch (e) { console.error(e); row.progress(null); row.meta(`<span class="bad">${esc(e.message)}</span>`); }
  }
}
