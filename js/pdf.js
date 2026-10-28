// Compress PDF: recompress the pictures inside the PDF (text and vector drawings untouched), deflate
// uncompressed streams, and repack the file with object streams. Runs fully in the browser with pdf-lib.
import { CDN } from "./config.js";
import { esc, fmtBytes, baseName, dropzone, button, download, downloadZip, compareView, toast } from "./ui.js";
import { encodeJpeg } from "./codecs.js";

// keep: only swap a picture when the new one is at most this fraction of the old size
// Pictures are re-encoded with MozJPEG (better quality per byte than the browser's JPEG encoder).
const LEVELS = {
  light: { maxDim: 2600, q: 86, keep: 0.95, label: "Light", sub: "Best quality, print ready" },
  balanced: { maxDim: 1700, q: 72, keep: 0.97, label: "Recommended", sub: "Sharp on any screen" },
  strong: { maxDim: 1150, q: 55, keep: 0.99, label: "Strong", sub: "Smallest, still readable" },
  extreme: { dpi: 110, q: 55, label: "Extreme", sub: "Pages become images: text can't be selected" },
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
      const jpg = new Uint8Array(await (await encodeJpeg(c, level.q)).arrayBuffer());
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
  onProgress(0.9);
  let out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  // last pass with qpdf: recompress every stream at maximum level, pack objects tighter
  try {
    const { runQpdf } = await import("./pdftools.js");
    const q = await runQpdf(out, ["IN", "--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9", "OUT"]);
    if (q.length < out.length) out = q;
  } catch (e) { console.warn("qpdf pass skipped", e); }
  onProgress(1);
  const fonts = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && (o.dict.get(N("Length1")) || o.dict.get(N("Length2")) || /Type1C|CIDFontType0C|OpenType/.test(String(o.dict.get(N("Subtype")))))).reduce((a, [, o]) => a + o.getContents().length, 0);
  return { bytes: out.length < bytes.length ? out : bytes, images: images.length, changed, skipped, fonts, pages: doc.getPageCount(), smaller: out.length < bytes.length };
}

export function mount(panel) {
  const intro = document.createElement("p"); intro.className = "hint";
  intro.innerHTML = "Every level is computed so you can compare real sizes and preview the quality before downloading. Levels change how much the <b>pictures</b> inside the PDF are compressed; text and drawings always stay sharp and selectable.";
  const jobs = document.createElement("div"); jobs.className = "jobs";
  panel.append(dropzone({ accept: "application/pdf,.pdf", multiple: true, title: "Drop PDFs here or click to choose", sub: "Files stay on your device", onFiles: add }), intro, jobs);
  const picks = []; let chain = Promise.resolve();
  const tail = document.createElement("div"); tail.className = "row-end"; tail.hidden = true;
  tail.append(button("Download all chosen (.zip)", "btn btn--primary", () => downloadZip(picks.filter(Boolean).map((p) => p()), "q-ft-compressed-pdfs.zip")));
  panel.append(tail);

  function add(files) { for (const f of files) { const card = document.createElement("div"); card.className = "pdfcard"; jobs.appendChild(card); const i = picks.push(null) - 1; chain = chain.then(() => run(f, card, i)); } }

  async function run(f, card, idx) {
    const bytes = new Uint8Array(await f.arrayBuffer()), name = `${baseName(f.name)}_compressed.pdf`;
    card.innerHTML = `<div class="pdfcard__head"><div class="job__thumb">PDF</div><div><div class="job__name">${esc(f.name)}</div><div class="job__meta">${fmtBytes(f.size)} · analyzing…</div><div class="bar"><i></i></div></div></div><div class="levels"></div><div class="pdfcard__preview"></div>`;
    const meta = card.querySelector(".job__meta"), bar = card.querySelector(".bar i"), grid = card.querySelector(".levels"), prev = card.querySelector(".pdfcard__preview");
    const res = {}; let chosen = null;
    const tile = (k) => {
      const L = LEVELS[k], r = res[k], t = document.createElement("div"); t.className = `lvl${k === chosen ? " on" : ""}`;
      if (!r) { t.innerHTML = `<b>${L.label}</b><small>${L.sub}</small>`; t.append(button("Try it", "btn btn--ghost btn--sm", async () => { t.innerHTML = `<b>${L.label}</b><small>Working…</small>`; await compute(k); draw(); })); return t; }
      const saved = Math.max(0, 1 - r.bytes.length / bytes.length);
      t.innerHTML = `<b>${L.label}</b><span class="lvl__size">${fmtBytes(r.bytes.length)}</span><span class="lvl__pct ${saved > 0.01 ? "ok" : ""}">${saved > 0.01 ? `${Math.round(saved * 100)}% smaller` : "no gain"}</span><small>${L.sub}</small>`;
      const row = document.createElement("div"); row.className = "lvl__btns";
      row.append(button("Preview", "btn btn--ghost btn--sm", () => preview(k)), button("Download", "btn btn--primary btn--sm", () => download(new Blob([r.bytes], { type: "application/pdf" }), name)));
      t.append(row); t.addEventListener("click", (e) => { if (e.target.closest("button")) return; chosen = k; picks[idx] = () => ({ name, blob: new Blob([res[k].bytes], { type: "application/pdf" }) }); draw(); });
      return t;
    };
    const draw = () => { grid.replaceChildren(...Object.keys(LEVELS).map(tile)); };
    async function compute(k) { res[k] = await compressPdf(bytes, k, (p) => (bar.style.width = `${Math.round(p * 100)}%`)); }
    try {
      for (const k of ["balanced", "light", "strong"]) { meta.textContent = `${fmtBytes(f.size)} · computing ${LEVELS[k].label}…`; await compute(k); }
      const r = res.balanced; card.querySelector(".bar").hidden = true;
      const same = res.light.bytes.length === res.strong.bytes.length;
      meta.innerHTML = `${fmtBytes(f.size)} · ${r.pages} page${r.pages === 1 ? "" : "s"} · ${r.images ? `${r.images} picture${r.images === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} in a compact scan format, left as is)` : ""}` : "no pictures"} · fonts ${fmtBytes(r.fonts)}`;
      if (same) { const n = document.createElement("p"); n.className = "hint"; n.innerHTML = r.images && r.skipped === r.images ? "The pictures in this PDF are already in compact scan formats, so the levels give the same result. <b>Extreme</b> can still shrink it by rebuilding each page as an image." : "This PDF is mostly text and fonts, so every level gives the same result: there are no pictures to compress. What you get is a lossless clean-up of the file's structure."; card.insertBefore(n, prev); }
      chosen = "balanced"; picks[idx] = () => ({ name, blob: new Blob([res.balanced.bytes], { type: "application/pdf" }) });
      draw(); tail.hidden = picks.filter(Boolean).length < 2;
    } catch (e) { console.error(e); meta.innerHTML = `<span class="bad">${esc(e.message)}</span>`; card.querySelector(".bar").hidden = true; }

    async function preview(k) {
      prev.innerHTML = `<div class="status"><span class="spin"></span>Rendering page 1…</div>`;
      try {
        const { renderPdfPage } = await import("./pdftools.js");
        const w = Math.min(1100, prev.clientWidth || 900);
        const [a, b] = await Promise.all([renderPdfPage(bytes, 1, w * 1.5), renderPdfPage(res[k].bytes, 1, w * 1.5)]);
        prev.replaceChildren(); compareView(prev, a, b, ["Original", LEVELS[k].label]);
      } catch (e) { prev.textContent = ""; toast("Couldn't render a preview of this PDF"); }
    }
  }
}
