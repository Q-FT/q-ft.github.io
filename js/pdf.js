// Compress PDF: recompress the pictures inside the PDF (text and vector drawings untouched), deflate
// uncompressed streams, and repack the file with object streams. Runs fully in the browser with pdf-lib.
// Speed: the PDF is read once, each picture is decoded once and encoded for every level in the same go,
// and pictures are processed in parallel by a pool of workers (one per spare CPU core).
import { CDN } from "./config.js";
import { esc, fmtBytes, baseName, dropzone, button, download, downloadZip, compareView, toast } from "./ui.js";

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

// ---- worker pool (kept warm between files, closed after a minute idle)
const pool = { workers: [], idle: [], queue: [], timer: 0, broken: false };
const poolSize = () => Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
function spawn() {
  const w = new Worker(new URL("./pdfimage-worker.js", import.meta.url), { type: "module" });
  w.onmessage = ({ data }) => { const t = w.task; w.task = null; data.error ? t.reject(new Error(data.error)) : t.resolve(data.out); release(w); };
  w.onerror = (e) => { e.preventDefault?.(); const t = w.task; w.task = null; pool.broken = true; retire(w); t?.fallback(); };
  pool.workers.push(w); return w;
}
function retire(w) { w.terminate(); pool.workers = pool.workers.filter((x) => x !== w); pool.idle = pool.idle.filter((x) => x !== w); }
function release(w) {
  const next = pool.queue.shift();
  if (next) return send(w, next);
  pool.idle.push(w);
  clearTimeout(pool.timer); pool.timer = setTimeout(() => { if (pool.idle.length === pool.workers.length) pool.workers.slice().forEach(retire); }, 60000);
}
function send(w, t) { w.task = t; w.postMessage({ id: 0, job: t.job }, [t.job.raw.buffer]); }
async function onMain(job) { const { processImage } = await import("./pdfimage.js"); return processImage(job); }
function runJob(job) {
  if (pool.broken || typeof Worker === "undefined") return onMain(job);
  return new Promise((resolve, reject) => {
    const backup = { ...job, raw: job.raw.slice() };               // in case the worker can't start (very old browsers)
    const t = { job, resolve, reject, fallback: () => onMain(backup).then(resolve, reject) };
    const w = pool.idle.pop() || (pool.workers.length < poolSize() ? spawn() : null);
    w ? send(w, t) : pool.queue.push(t);
  });
}

/** One level (kept for the tests and the Extreme button). */
export async function compressPdf(bytes, levelKey, onProgress = () => {}) {
  return (await compressAll(bytes, [levelKey], onProgress))[levelKey];
}

/** Several levels at once. onLevel(key, result) fires as each level is ready. */
export async function compressAll(bytes, keys, onProgress = () => {}, onLevel = () => {}) {
  const { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict, PDFBool, pako } = await libs();
  const res = {};
  const picture = keys.filter((k) => !LEVELS[k].dpi);
  for (const k of keys.filter((k) => LEVELS[k].dpi)) { // extreme: every page becomes one JPEG (text is no longer selectable)
    const { rasterize } = await import("./pdftools.js");
    const out = await rasterize(bytes, LEVELS[k].dpi, LEVELS[k].q, onProgress);
    res[k] = { bytes: out.length < bytes.length ? out : bytes, images: 0, changed: 0, skipped: 0, smaller: out.length < bytes.length, flattened: true };
    onLevel(k, res[k]);
  }
  if (!picture.length) return res;

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

  // 1. find every picture we can recompress
  const images = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && String(o.dict.get(N("Subtype"))) === "/Image");
  let skipped = 0;
  const items = [];
  for (const [ref, obj] of images) {
    const d = obj.dict;
    if (look(d.get(N("ImageMask"))) === PDFBool.True) continue;
    const w = num(d.get(N("Width"))), h = num(d.get(N("Height"))), bpc = num(d.get(N("BitsPerComponent"))) || 8;
    const cs = colorSpace(d.get(N("ColorSpace"))), filters = filtersOf(d), raw = obj.getContents();
    if (!w || !h || w * h < 4096 || !cs || d.get(N("Decode")) || d.get(N("SMaskInData")) || ![1, 2, 4, 8].includes(bpc)) { skipped++; continue; }
    let kind, pred = { predictor: 1 };
    if (filters.length === 1 && filters[0] === "/DCTDecode" && (cs.n === 3 || cs.n === 1) && !cs.palette) kind = "jpeg";
    else if (filters.length <= 1 && (!filters.length || filters[0] === "/FlateDecode")) {
      kind = filters.length ? "flate" : "plain";
      const parms = look(d.get(N("DecodeParms")));
      if (parms instanceof PDFDict) pred = { predictor: num(parms.get(N("Predictor"))) || 1, colors: num(parms.get(N("Colors"))), columns: num(parms.get(N("Columns"))) };
      if (pred.predictor !== 1 && pred.predictor < 10) { skipped++; continue; }
    } else { skipped++; continue; } // JPEG 2000, JBIG2, CCITT: already compact formats
    items.push({ ref, obj, d, raw, size: raw.length, job: { kind, w, h, bpc, cs, pred } });
  }

  // 2. encode in rounds: the quick levels first so they show up sooner, then Light (large, slow to encode).
  //    Each round decodes every picture once and encodes it for all of that round's levels, on all cores.
  const rounds = [picture.filter((k) => k !== "light"), picture.filter((k) => k === "light")].filter((r) => r.length);
  const steps = rounds.length * Math.max(1, items.length); let done = 0;
  const bad = new Set();
  const fonts = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && (o.dict.get(N("Length1")) || o.dict.get(N("Length2")) || /Type1C|CIDFontType0C|OpenType/.test(String(o.dict.get(N("Subtype")))))).reduce((a, [, o]) => a + o.getContents().length, 0);
  for (const round of rounds) {
   const levels = round.map((key) => ({ key, maxDim: LEVELS[key].maxDim, q: LEVELS[key].q }));
   const pics = (await Promise.all(items.map((it) => runJob({ ...it.job, raw: it.raw.slice(), levels })
     .then((out) => { if (!out) bad.add(it.ref); return out && { ...it, out }; })
     .catch((e) => { console.warn("image skipped", e); bad.add(it.ref); return null; })
     .finally(() => onProgress(0.05 + 0.85 * (++done / steps)))))).filter(Boolean);
   // 3. build each level: swap in its pictures (or put the originals back), save, final qpdf pass
   for (const key of round) {
    let changed = 0;
    for (const p of pics) {
      const r = p.out[key];
      if (!r || r.jpg.length > p.size * LEVELS[key].keep) { ctx.assign(p.ref, p.obj); continue; } // not worth it: keep the original
      const nd = p.d.clone(ctx);
      for (const k of ["Filter", "DecodeParms", "Decode", "Length", "BitsPerComponent", "ColorSpace", "Width", "Height"]) nd.delete(N(k));
      nd.set(N("Filter"), N("DCTDecode")); nd.set(N("ColorSpace"), N("DeviceRGB")); nd.set(N("BitsPerComponent"), PDFNumber.of(8));
      nd.set(N("Width"), PDFNumber.of(r.w)); nd.set(N("Height"), PDFNumber.of(r.h)); nd.set(N("Length"), PDFNumber.of(r.jpg.length));
      ctx.assign(p.ref, PDFRawStream.of(nd, r.jpg));
      changed++;
    }
    let out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
    try { // qpdf: compress every stream at the maximum level (including ones stored uncompressed), pack objects tighter
      const { runQpdf } = await import("./pdftools.js");
      const q = await runQpdf(out, ["IN", "--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9", "OUT"]);
      if (q.length < out.length) out = q;
    } catch (e) { // qpdf unavailable: deflate uncompressed streams ourselves
      console.warn("qpdf pass skipped", e);
      const swapped = [];
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream) || obj.dict.get(N("Filter")) || String(obj.dict.get(N("Type"))) === "/Metadata") continue;
        const raw = obj.getContents(); if (raw.length < 256) continue;
        const z = pako.deflate(raw, { level: 9 }); if (z.length > raw.length * 0.9) continue;
        const nd = obj.dict.clone(ctx); nd.set(N("Filter"), N("FlateDecode")); nd.set(N("Length"), PDFNumber.of(z.length));
        ctx.assign(ref, PDFRawStream.of(nd, z)); swapped.push([ref, obj]);
      }
      if (swapped.length) { const z = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }); if (z.length < out.length) out = z; }
      for (const [ref, obj] of swapped) ctx.assign(ref, obj);
    }
    res[key] = { bytes: out.length < bytes.length ? out : bytes, images: images.length, changed, skipped: skipped + bad.size, fonts, pages: doc.getPageCount(), smaller: out.length < bytes.length };
    onLevel(key, res[key]);
   }
  }
  onProgress(1);
  return res;
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
    const res = {}, pending = new Set(["balanced", "strong", "light"]); let chosen = null;
    const tile = (k) => {
      const L = LEVELS[k], r = res[k], t = document.createElement("div"); t.className = `lvl${k === chosen ? " on" : ""}`;
      if (!r && pending.has(k)) { t.innerHTML = `<b>${L.label}</b><small>Working…</small>`; return t; }
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
      meta.textContent = `${fmtBytes(f.size)} · compressing pictures…`;
      await compressAll(bytes, ["balanced", "strong", "light"], (p) => (bar.style.width = `${Math.round(p * 100)}%`),
        (k, r) => { // show each level as soon as it's ready; Recommended is picked by default
          res[k] = r; pending.delete(k);
          if (k === "balanced") { chosen = "balanced"; picks[idx] = () => ({ name, blob: new Blob([res.balanced.bytes], { type: "application/pdf" }) }); }
          if (pending.size) meta.textContent = `${fmtBytes(f.size)} · ${[...pending].map((x) => LEVELS[x].label).join(" & ")} still working…`;
          draw();
        });
      const r = res.balanced; card.querySelector(".bar").hidden = true;
      const same = res.light.bytes.length === res.strong.bytes.length;
      meta.innerHTML = `${fmtBytes(f.size)} · ${r.pages} page${r.pages === 1 ? "" : "s"} · ${r.images ? `${r.images} picture${r.images === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} in a compact scan format, left as is)` : ""}` : "no pictures"} · fonts ${fmtBytes(r.fonts)}`;
      if (same) { const n = document.createElement("p"); n.className = "hint"; n.innerHTML = r.images && r.skipped === r.images ? "The pictures in this PDF are already in compact scan formats, so the levels give the same result. <b>Extreme</b> can still shrink it by rebuilding each page as an image." : "This PDF is mostly text and fonts, so every level gives the same result: there are no pictures to compress. What you get is a lossless clean-up of the file's structure."; card.insertBefore(n, prev); }
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
