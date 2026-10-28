// The PDF toolbox: merge, split, organize/remove/rotate/extract pages, scan, repair, OCR, JPG<->PDF, Markdown,
// edit/sign, page numbers, watermark, crop, forms, protect/unlock, redact, compare. All in the browser.
// pdf-lib writes PDFs, PDF.js renders and reads text, qpdf (wasm) handles encryption, Tesseract does OCR.
import { CDN } from "./config.js";
import { $, esc, fmtBytes, baseName, dropzone, segmented, opt, jobRow, button, download, downloadZip, toast } from "./ui.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const QPDF = "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/";
const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js";

// ---------------------------------------------------------------- libraries (loaded on first use)
let libP, jsP, qpdfP;
const pdfLib = () => (libP ||= import(CDN.pdfLib));
const pdfjs = () => (jsP ||= (async () => {
  const lib = await import(`${PDFJS}pdf.min.mjs`);
  // cross-origin module workers aren't allowed, so run the worker from a same-origin blob
  const src = await (await fetch(`${PDFJS}pdf.worker.min.mjs`)).text();
  lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
  return lib;
})());
const qpdf = () => (qpdfP ||= new Promise((res, rej) => {
  const s = Object.assign(document.createElement("script"), { src: `${QPDF}qpdf.js` });
  s.onload = () => res(window.Module); s.onerror = () => { qpdfP = null; rej(new Error("Couldn't load the encryption engine")); };
  document.head.appendChild(s);
}));
export async function runQpdf(bytes, args) {
  const create = await qpdf();
  const logs = [];
  const m = await create({ locateFile: () => `${QPDF}qpdf.wasm`, noInitialRun: true, print: (t) => logs.push(t), printErr: (t) => logs.push(t) });
  m.FS.writeFile("/in.pdf", bytes);
  let code = 0;
  try { code = m.callMain(args.map((a) => (a === "IN" ? "/in.pdf" : a === "OUT" ? "/out.pdf" : a))); } catch (e) { code = e?.status ?? 1; }
  if (code !== 0 && code !== 3) throw Object.assign(new Error(logs.join(" ") || "qpdf failed"), { logs }); // 3 = success with warnings
  return m.FS.readFile("/out.pdf");
}

const readBytes = async (f) => new Uint8Array(await f.arrayBuffer());
const openJs = async (bytes, password) => (await pdfjs()).getDocument({ data: bytes.slice(), password }).promise;
async function openLib(bytes) {
  const { PDFDocument } = await pdfLib();
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypt/i.test(e.message) ? "This PDF is password-protected. Use Unlock PDF first." : "This file couldn't be read as a PDF. Try Repair PDF."); }
}
const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });
const el = (tag, cls, html) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, html != null ? { innerHTML: html } : {});

async function renderPage(doc, n, width, rotate = 0) {
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1, rotation: (page.rotate + rotate) % 360 });
  const vp = page.getViewport({ scale: width / vp1.width, rotation: (page.rotate + rotate) % 360 });
  const c = Object.assign(document.createElement("canvas"), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return { canvas: c, viewport: vp, page };
}

/** Parse "1-3, 5, 8-" into 0-based page indexes. */
function parseRanges(str, count) {
  const out = [];
  for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)-(\d*)$/); let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; } else if (/^\d+$/.test(part)) a = b = +part; else throw new Error(`"${part}" isn't a page range`);
    if (a < 1 || b > count || a > b) throw new Error(`Pages go from 1 to ${count}`);
    out.push([a - 1, b - 1]);
  }
  return out;
}

const resultBox = () => el("div", "jobs");
function showResult(box, name, blob, extra = "") {
  const row = jobRow(name, "✓"); row.progress(null);
  row.meta(`<span class="ok">Ready</span> · ${fmtBytes(blob.size)}${extra ? ` · ${extra}` : ""}`);
  row.actions(button("Download", "btn btn--primary btn--sm", () => download(blob, name)));
  box.replaceChildren(row.el);
}
const status = () => { const s = el("div", "status"); s.hidden = true; s.set = (m) => { s.hidden = !m; s.innerHTML = m ? `<span class="spin"></span>${esc(m)}` : ""; }; return s; };
const field = (label, input) => opt(label, input);
const input = (type, value, attrs = {}) => Object.assign(document.createElement("input"), { type, value, ...attrs });
const select = (pairs, value) => { const s = document.createElement("select"); s.innerHTML = pairs.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join(""); return s; };

/** One PDF in, panel with options, "go" button. Calls work(file, bytes) and shows the returned {name, blob}. */
function singlePdf(panel, { title = "Drop a PDF here or click to choose", sub = "Stays on your device", build, cta, onLoad }) {
  const opts = el("div", "opts"), st = status(), out = resultBox(), go = button(cta, "btn btn--primary btn--lg");
  const head = el("div", "jobs"), actions = el("div", "row-end"); actions.append(go);
  let file = null, bytes = null;
  const dz = dropzone({ accept: "application/pdf,.pdf", title, sub, onFiles: async ([f]) => {
    file = f; bytes = await readBytes(f);
    const row = jobRow(f.name, "PDF"); row.progress(null); row.meta(fmtBytes(f.size));
    row.actions(button("Change file", "btn btn--ghost btn--sm", () => { dz.hidden = false; work.hidden = true; out.replaceChildren(); }));
    head.replaceChildren(row.el); dz.hidden = true; work.hidden = false; out.replaceChildren();
    try { await onLoad?.({ file, bytes, opts, row }); } catch (e) { st.set(""); toast(e.message, 5000); }
  } });
  const work = el("div"); work.hidden = true; work.append(head, opts, actions, st, out);
  panel.append(dz, work);
  go.addEventListener("click", async () => {
    if (!bytes) return; go.disabled = true; out.replaceChildren();
    try { const r = await build({ file, bytes, set: st.set }); if (r) showResult(out, r.name, r.blob, r.extra); }
    catch (e) { console.error(e); toast(e.message || "Something went wrong", 5000); }
    finally { st.set(""); go.disabled = false; }
  });
  return { opts, work, st };
}

// ---------------------------------------------------------------- merge / images to PDF / scan (ordered file list)
function fileList(panel, { accept, title, sub, cta, build, extraOpts, thumbs = true }) {
  const items = []; const list = el("div", "jobs"), opts = el("div", "opts"), st = status(), out = resultBox();
  const go = button(cta, "btn btn--primary btn--lg"); go.disabled = true;
  const actions = el("div", "row-end"); actions.append(go);
  extraOpts?.(opts);
  const draw = () => {
    list.replaceChildren(...items.map((it, i) => {
      const r = jobRow(it.file.name, it.file.type.startsWith("image/") && thumbs ? "" : "PDF"); r.progress(null);
      if (it.thumb) r.thumb(Object.assign(document.createElement("img"), { src: it.thumb, className: "job__thumb", alt: "" }));
      r.meta(`${i + 1} · ${fmtBytes(it.file.size)}`);
      r.actions(button("↑", "btn btn--ghost btn--sm", () => move(i, -1)), button("↓", "btn btn--ghost btn--sm", () => move(i, 1)), button("✕", "btn btn--ghost btn--sm", () => { items.splice(i, 1); draw(); }));
      return r.el;
    }));
    go.disabled = items.length < (cta.startsWith("Merge") ? 2 : 1);
  };
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; draw(); };
  const dz = dropzone({ accept, multiple: true, title, sub, onFiles: (fs) => { for (const f of fs) items.push({ file: f, thumb: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }); draw(); } });
  panel.append(dz, list, opts, actions, st, out);
  go.addEventListener("click", async () => {
    go.disabled = true; out.replaceChildren();
    try { const r = await build(items.map((x) => x.file), st.set); showResult(out, r.name, r.blob, r.extra); }
    catch (e) { console.error(e); toast(e.message || "Something went wrong", 5000); }
    finally { st.set(""); go.disabled = false; }
  });
  return { opts };
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
async function imageToPdfPage(pdf, file, { size = "fit", margin = 0, orient = "auto", filter } = {}) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const c = Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height }), g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0); bmp.close();
  if (filter) filter(c);
  const isPng = file.type === "image/png" && !filter;
  const blob = await new Promise((r) => c.toBlob(r, isPng ? "image/png" : "image/jpeg", 0.92));
  const data = new Uint8Array(await blob.arrayBuffer());
  const img = isPng ? await pdf.embedPng(data) : await pdf.embedJpg(data);
  let [pw, ph] = size === "fit" ? [img.width * 0.75, img.height * 0.75] : PAGE_SIZES[size];
  const land = orient === "landscape" || (orient === "auto" && size !== "fit" && img.width > img.height);
  if (land && size !== "fit") [pw, ph] = [ph, pw];
  const m = size === "fit" ? 0 : margin, k = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
  const page = pdf.addPage([pw, ph]); const w = img.width * k, h = img.height * k;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/** Scanner look: flatten uneven lighting (divide by a blurred copy), then boost contrast. */
function docFilter(mode) {
  return (c) => {
    if (mode === "color") return;
    const g = c.getContext("2d", { willReadFrequently: true }), W = c.width, H = c.height;
    const small = Object.assign(document.createElement("canvas"), { width: Math.max(1, W >> 5), height: Math.max(1, H >> 5) });
    const sg = small.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(c, 0, 0, small.width, small.height);
    const bg = Object.assign(document.createElement("canvas"), { width: W, height: H }); const bgg = bg.getContext("2d", { willReadFrequently: true });
    bgg.imageSmoothingQuality = "high"; bgg.drawImage(small, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data, b = bgg.getImageData(0, 0, W, H).data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], by = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2] || 1;
      let v = Math.min(255, (y / by) * 255); v = v > 235 ? 255 : Math.max(0, (v - 70) * 1.45);
      if (mode === "bw") v = v > 165 ? 255 : v < 90 ? 0 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  };
}

// ---------------------------------------------------------------- page grid (organize, remove, rotate, extract)
async function pageGrid(container, bytes, { mode, set }) {
  set("Reading pages…");
  const doc = await openJs(bytes), n = doc.numPages;
  const pages = Array.from({ length: n }, (_, i) => ({ i, rot: 0, del: false, sel: false }));
  const grid = el("div", "pages"); container.replaceChildren(grid);
  let dragFrom = null;
  const card = (p) => {
    const c = el("div", "pg"); c.draggable = mode === "organize"; c.dataset.i = p.i;
    c.innerHTML = `<div class="pg__img"></div><div class="pg__bar"><span>${p.i + 1}</span></div>`;
    const bar = $(".pg__bar", c);
    if (mode === "organize" || mode === "rotate") bar.append(button("⟳", "btn btn--ghost btn--sm", (e) => { e.stopPropagation(); p.rot = (p.rot + 90) % 360; $(".pg__img", c).style.transform = `rotate(${p.rot}deg)`; }));
    if (mode === "organize" || mode === "remove") bar.append(button("✕", "btn btn--ghost btn--sm", (e) => { e.stopPropagation(); p.del = !p.del; c.classList.toggle("del", p.del); }));
    if (mode === "extract") c.addEventListener("click", () => { p.sel = !p.sel; c.classList.toggle("sel", p.sel); });
    if (mode === "remove") c.addEventListener("click", () => { p.del = !p.del; c.classList.toggle("del", p.del); });
    if (mode === "rotate") c.addEventListener("click", () => { p.rot = (p.rot + 90) % 360; $(".pg__img", c).style.transform = `rotate(${p.rot}deg)`; });
    c.addEventListener("dragstart", () => { dragFrom = c; c.classList.add("drag"); });
    c.addEventListener("dragend", () => c.classList.remove("drag"));
    c.addEventListener("dragover", (e) => { if (!dragFrom || dragFrom === c) return; e.preventDefault(); const r = c.getBoundingClientRect(); grid.insertBefore(dragFrom, e.clientX < r.left + r.width / 2 ? c : c.nextSibling); });
    return c;
  };
  pages.forEach((p) => grid.appendChild(card(p)));
  set("");
  // thumbnails, a few at a time
  (async () => { for (const p of pages) { try { const { canvas } = await renderPage(doc, p.i + 1, 180); grid.querySelector(`[data-i="${p.i}"] .pg__img`).appendChild(canvas); } catch {} } })();
  return {
    count: n,
    order: () => [...grid.children].map((c) => pages[+c.dataset.i]),
    all: (fn) => { pages.forEach(fn); grid.querySelectorAll(".pg").forEach((c) => { const p = pages[+c.dataset.i]; c.classList.toggle("sel", p.sel); c.classList.toggle("del", p.del); $(".pg__img", c).style.transform = `rotate(${p.rot}deg)`; }); },
  };
}
async function rebuild(bytes, list) {
  const { PDFDocument, degrees } = await pdfLib();
  const src = await openLib(bytes), out = await PDFDocument.create();
  const copied = await out.copyPages(src, list.map((p) => p.i));
  copied.forEach((pg, k) => { const r = list[k].rot || 0; if (r) pg.setRotation(degrees((pg.getRotation().angle + r) % 360)); out.addPage(pg); });
  return out.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- page editor (edit, sign, redact)
const SIG_FONTS = [["'Caveat', cursive", "Caveat"], ["'Dancing Script', cursive", "Dancing Script"], ["'Great Vibes', cursive", "Great Vibes"]];
function loadSigFonts() {
  if (document.getElementById("sigFonts")) return;
  document.head.appendChild(Object.assign(document.createElement("link"), { id: "sigFonts", rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&display=swap" }));
}

/** Signature maker: draw / type / upload. Resolves with a trimmed PNG data URL (or null). */
function signatureDialog() {
  loadSigFonts();
  return new Promise((resolve) => {
    const d = el("dialog", "paywall sigdlg");
    d.innerHTML = `<form method="dialog" class="paywall__in" style="align-items:stretch;text-align:left"><h2>Your signature</h2><div data-tabs></div><div data-body></div><div class="row-end"><button class="btn btn--ghost" value="cancel">Cancel</button><button class="btn btn--primary" type="button" data-ok>Use signature</button></div></form>`;
    document.body.appendChild(d);
    let tab = "draw", ink = "#111827";
    const body = $("[data-body]", d);
    const pad = Object.assign(document.createElement("canvas"), { width: 1000, height: 340, className: "sigpad" });
    const pg = pad.getContext("2d"); pg.lineCap = pg.lineJoin = "round"; pg.lineWidth = 5;
    let drawing = false, last = null, drawn = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
    pad.addEventListener("pointermove", (e) => { if (!drawing) return; const p = pos(e); pg.strokeStyle = ink; pg.beginPath(); pg.moveTo(...last); pg.lineTo(...p); pg.stroke(); last = p; drawn = true; });
    pad.addEventListener("pointerup", () => (drawing = false));
    const typed = input("text", "", { placeholder: "Type your name", className: "sigtype" });
    const fontSel = select(SIG_FONTS, SIG_FONTS[0][0]);
    const upload = input("file", "", { accept: "image/*" });
    const inkSeg = segmented([["#111827", "Black"], ["#1d4ed8", "Blue"]], ink, (v) => { ink = v; typed.style.color = v; });
    const show = () => {
      body.replaceChildren();
      if (tab === "draw") body.append(pad, el("div", "row-end", ""), inkSeg.el), body.querySelector(".row-end").append(button("Clear", "btn btn--ghost btn--sm", () => { pg.clearRect(0, 0, pad.width, pad.height); drawn = false; }));
      if (tab === "type") { typed.style.fontFamily = fontSel.value; body.append(typed, fontSel, inkSeg.el); }
      if (tab === "upload") body.append(upload, el("p", "hint", "A photo of your signature on white paper works best: the white is removed automatically."));
    };
    fontSel.addEventListener("change", () => (typed.style.fontFamily = fontSel.value));
    $("[data-tabs]", d).append(segmented([["draw", "Draw"], ["type", "Type"], ["upload", "Upload"]], tab, (v) => { tab = v; show(); }).el);
    show();
    const trim = (c) => { // crop to the ink and make the background transparent
      const g = c.getContext("2d", { willReadFrequently: true }), { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const lum = (data[i] + data[i + 1] + data[i + 2]) / 3; if (data[i + 3] > 20 && lum < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } else data[i + 3] = 0; }
      if (x1 <= x0) return null;
      const t = Object.assign(document.createElement("canvas"), { width: x1 - x0 + 12, height: y1 - y0 + 12 });
      const tmp = Object.assign(document.createElement("canvas"), { width: W, height: H }); tmp.getContext("2d").putImageData(new ImageData(data, W, H), 0, 0);
      t.getContext("2d").drawImage(tmp, x0 - 6, y0 - 6, t.width, t.height, 0, 0, t.width, t.height);
      return t.toDataURL("image/png");
    };
    $("[data-ok]", d).addEventListener("click", async () => {
      let url = null;
      if (tab === "draw" && drawn) url = trim(pad);
      if (tab === "type" && typed.value.trim()) {
        await document.fonts.load(`120px ${fontSel.value}`);
        const c = Object.assign(document.createElement("canvas"), { width: 1400, height: 300 }), g = c.getContext("2d");
        g.font = `120px ${fontSel.value}`; g.fillStyle = ink; g.textBaseline = "middle"; g.fillText(typed.value.trim(), 20, 150); url = trim(c);
      }
      if (tab === "upload" && upload.files[0]) {
        const bmp = await createImageBitmap(upload.files[0], { imageOrientation: "from-image" }); const k = Math.min(1, 1400 / bmp.width);
        const c = Object.assign(document.createElement("canvas"), { width: bmp.width * k, height: bmp.height * k }); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); url = trim(c);
      }
      if (!url) { toast("Add your signature first"); return; }
      d.close(); d.remove(); resolve(url);
    });
    d.addEventListener("close", () => { d.remove(); resolve(null); });
    d.showModal();
  });
}

async function pageEditor(panel, bytes, kind, set) {
  const doc = await openJs(bytes), n = doc.numPages;
  const items = []; let pageNo = 1, view = null, tool = kind === "redact" ? "redact" : null;
  const bar = el("div", "edbar"), stage = el("div", "stage"), nav = el("div", "row-end edit-nav");
  const holder = el("div", "stage__page"); stage.append(holder);
  const prev = button("← Prev", "btn btn--ghost btn--sm", () => go(pageNo - 1)), next = button("Next →", "btn btn--ghost btn--sm", () => go(pageNo + 1));
  const pageLab = el("span", "muted small");
  nav.append(prev, pageLab, next);
  const toolBtns = {};
  const addTool = (id, label, onClick) => { const b = button(label, "btn btn--ghost btn--sm", onClick || (() => { tool = tool === id ? null : id; Object.entries(toolBtns).forEach(([k, x]) => x.classList.toggle("on", k === tool)); hint(); })); toolBtns[id] = b; bar.append(b); };
  const hintEl = el("p", "hint");
  const hint = () => { hintEl.textContent = tool === "redact" ? "Drag over anything you want to black out. It's removed for real: those pages are flattened into images." : tool === "white" ? "Drag to cover something with white." : tool === "hl" ? "Drag over text to highlight it." : tool === "text" ? "Click where you want to type." : "Drag items to move them, use the corner to resize, ✕ to delete."; };
  if (kind === "edit") {
    addTool("text", "T  Text"); addTool("white", "▭  White-out"); addTool("hl", "▬  Highlight");
    addTool("img", "🖼  Image", async () => { const f = await pickFile("image/*"); if (!f) return; const url = await fileToDataUrl(f); addItem({ type: "img", src: url, w: 0.3, ratio: await ratioOf(url) }); });
    addTool("sig", "✍  Signature", async () => { const url = await signatureDialog(); if (url) addItem({ type: "img", src: url, w: 0.28, ratio: await ratioOf(url) }); });
  } else if (kind === "sign") {
    addTool("sig", "✍  Add signature", async () => { const url = await signatureDialog(); if (url) addItem({ type: "img", src: url, w: 0.28, ratio: await ratioOf(url) }); });
    addTool("text", "T  Add date or text");
  } else { addTool("redact", "■  Redact area"); toolBtns.redact.classList.add("on"); }
  hint();
  panel.append(bar, hintEl, stage, nav);

  async function go(p) {
    if (p < 1 || p > n) return; pageNo = p; pageLab.textContent = `Page ${p} of ${n}`; prev.disabled = p === 1; next.disabled = p === n;
    const width = Math.min(900, stage.clientWidth - 2);
    view = await renderPage(doc, p, width);
    holder.replaceChildren(view.canvas); holder.style.width = `${view.canvas.width}px`;
    drawItems();
  }
  function addItem(it) {
    const base = { page: pageNo, x: 0.35, y: 0.4, w: 0.3, h: 0.06 };
    const o = { ...base, ...it }; if (o.ratio) o.h = (o.w * view.canvas.width / o.ratio) / view.canvas.height;
    items.push(o); drawItems(); return o;
  }
  function drawItems() {
    holder.querySelectorAll(".it").forEach((x) => x.remove());
    const W = view.canvas.width, H = view.canvas.height;
    for (const it of items.filter((x) => x.page === pageNo)) {
      const node = el("div", `it it--${it.type}`);
      Object.assign(node.style, { left: `${it.x * W}px`, top: `${it.y * H}px`, width: `${it.w * W}px`, height: `${it.h * H}px` });
      if (it.type === "img") node.appendChild(Object.assign(document.createElement("img"), { src: it.src, alt: "", draggable: false }));
      if (it.type === "text") { const t = el("div", "it__text"); t.contentEditable = "true"; t.textContent = it.text; t.style.fontSize = `${it.size}px`; t.style.color = it.color; t.addEventListener("input", () => (it.text = t.innerText)); t.addEventListener("pointerdown", (e) => e.stopPropagation()); node.append(t); }
      const x = el("button", "it__x", "✕"); x.type = "button"; x.addEventListener("pointerdown", (e) => { e.stopPropagation(); items.splice(items.indexOf(it), 1); drawItems(); });
      const h = el("span", "it__h");
      node.append(x, h); holder.appendChild(node);
      drag(node, (dx, dy) => { it.x = clamp(it.x + dx / W, 0, 1 - it.w); it.y = clamp(it.y + dy / H, 0, 1 - it.h); node.style.left = `${it.x * W}px`; node.style.top = `${it.y * H}px`; });
      drag(h, (dx, dy) => { it.w = clamp(it.w + dx / W, 0.02, 1 - it.x); it.h = it.ratio ? (it.w * W / it.ratio) / H : clamp(it.h + dy / H, 0.01, 1 - it.y); node.style.width = `${it.w * W}px`; node.style.height = `${it.h * H}px`; });
    }
  }
  // draw new boxes / place text on the page
  holder.addEventListener("pointerdown", (e) => {
    if (!tool || e.target.closest(".it")) return;
    const r = view.canvas.getBoundingClientRect(), W = r.width, H = r.height, x0 = (e.clientX - r.left) / W, y0 = (e.clientY - r.top) / H;
    if (tool === "text") { const o = addItem({ type: "text", text: "Type here", size: 18, color: "#111827", x: x0, y: y0 - 0.015, w: 0.3, h: 0.04 }); setTimeout(() => { const t = holder.querySelectorAll(".it__text"); const last = t[t.length - 1]; last?.focus(); document.execCommand?.("selectAll"); }, 30); return o; }
    const it = addItem({ type: tool, x: x0, y: y0, w: 0.001, h: 0.001 }); const node = holder.querySelector(".it:last-of-type");
    holder.setPointerCapture(e.pointerId);
    const mv = (ev) => { const x1 = (ev.clientX - r.left) / W, y1 = (ev.clientY - r.top) / H; it.x = clamp(Math.min(x0, x1), 0, 1); it.y = clamp(Math.min(y0, y1), 0, 1); it.w = Math.min(Math.abs(x1 - x0), 1 - it.x); it.h = Math.min(Math.abs(y1 - y0), 1 - it.y); Object.assign(node.style, { left: `${it.x * W}px`, top: `${it.y * H}px`, width: `${it.w * W}px`, height: `${it.h * H}px` }); };
    const up = () => { holder.removeEventListener("pointermove", mv); holder.removeEventListener("pointerup", up); if (it.w < 0.005 || it.h < 0.005) items.splice(items.indexOf(it), 1); drawItems(); };
    holder.addEventListener("pointermove", mv); holder.addEventListener("pointerup", up);
  });
  await go(1);
  return {
    async build() {
      if (!items.length) throw new Error(kind === "redact" ? "Mark at least one area to redact" : "Add something to the page first");
      const { PDFDocument, rgb, StandardFonts, BlendMode } = await pdfLib();
      const out = await openLib(bytes);
      if (kind === "redact") return flattenRedactions(out, PDFDocument, set);
      const font = await out.embedFont(StandardFonts.Helvetica); const imgCache = new Map();
      for (const it of items) {
        set(`Writing page ${it.page}…`);
        const pjs = await doc.getPage(it.page), vp = pjs.getViewport({ scale: 1 }), page = out.getPage(it.page - 1);
        const [ax, ay] = vp.convertToPdfPoint(it.x * vp.width, it.y * vp.height), [bx, by] = vp.convertToPdfPoint((it.x + it.w) * vp.width, (it.y + it.h) * vp.height);
        const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
        if (it.type === "white") page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });
        if (it.type === "hl") page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 0.92, 0.2), opacity: 0.45, blendMode: BlendMode.Multiply });
        if (it.type === "img") { if (!imgCache.has(it.src)) imgCache.set(it.src, await out.embedPng(it.src)); page.drawImage(imgCache.get(it.src), { x, y, width: w, height: h }); }
        if (it.type === "text") {
          const scale = vp.width / (view.canvas.width), size = it.size * scale; const c = it.color.match(/\w\w/g).map((v) => parseInt(v, 16) / 255);
          (it.text || "").split("\n").forEach((line, k) => page.drawText(line.replace(/[^\x20-\xFF]/g, ""), { x, y: Math.max(ay, by) - size * (k + 1) * 1.05, size, font, color: rgb(...c) }));
        }
      }
      return out.save({ useObjectStreams: true });
    },
  };

  async function flattenRedactions(out, PDFDocument, set) {
    const pagesWith = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
    for (const p of pagesWith) {
      set(`Redacting page ${p}…`);
      const pjs = await doc.getPage(p), vp1 = pjs.getViewport({ scale: 1 });
      const { canvas } = await renderPage(doc, p, vp1.width * 2.5); const g = canvas.getContext("2d"); g.fillStyle = "#000";
      for (const it of items.filter((x) => x.page === p)) g.fillRect(it.x * canvas.width, it.y * canvas.height, it.w * canvas.width, it.h * canvas.height);
      const jpg = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92))).arrayBuffer());
      const img = await out.embedJpg(jpg);
      out.removePage(p - 1); const np = out.insertPage(p - 1, [vp1.width, vp1.height]);
      np.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    return out.save({ useObjectStreams: true });
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function drag(node, onMove) {
  node.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".it__x") || (e.target.isContentEditable && node.classList.contains("it"))) return;
    e.stopPropagation(); e.preventDefault(); node.setPointerCapture(e.pointerId); let lx = e.clientX, ly = e.clientY;
    const mv = (ev) => { onMove(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; };
    const up = () => { node.removeEventListener("pointermove", mv); node.removeEventListener("pointerup", up); };
    node.addEventListener("pointermove", mv); node.addEventListener("pointerup", up);
  });
}
const pickFile = (accept) => new Promise((r) => { const i = input("file", "", { accept }); i.onchange = () => r(i.files[0] || null); i.click(); });
const fileToDataUrl = async (f) => { const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); const c = Object.assign(document.createElement("canvas"), { width: bmp.width * k, height: bmp.height * k }); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL("image/png"); };
const ratioOf = (url) => new Promise((r) => { const i = new Image(); i.onload = () => r(i.width / i.height); i.src = url; });

// ---------------------------------------------------------------- text helpers (markdown, compare)
async function pageLines(doc, p) {
  const page = await doc.getPage(p), tc = await page.getTextContent();
  const rows = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const size = Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[0]), x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < size * 0.5);
    if (!row) rows.push((row = { y, size, parts: [] }));
    row.parts.push({ x, str: it.str, w: it.width }); row.size = Math.max(row.size, size);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => { r.parts.sort((a, b) => a.x - b.x); let s = "", end = null; for (const p of r.parts) { if (end != null && p.x - end > r.size * 0.25 && !s.endsWith(" ") && !p.str.startsWith(" ")) s += " "; s += p.str; end = p.x + p.w; } return { y: r.y, size: r.size, text: s.replace(/\s+/g, " ").trim() }; }).filter((r) => r.text);
}
async function toMarkdown(doc, set) {
  const all = [];
  for (let p = 1; p <= doc.numPages; p++) { set(`Reading page ${p} of ${doc.numPages}…`); all.push(...(await pageLines(doc, p)).map((l) => ({ ...l, page: p }))); }
  const sizes = all.map((l) => l.size).sort((a, b) => a - b), body = sizes[Math.floor(sizes.length / 2)] || 12;
  let md = "", prev = null;
  for (const l of all) {
    const r = l.size / body; let t = l.text;
    const bullet = t.match(/^[•◦▪●○■\-–*]\s*(.*)/);
    let line;
    if (r >= 1.6) line = `# ${t}`; else if (r >= 1.3) line = `## ${t}`; else if (r >= 1.12 && t.length < 90) line = `### ${t}`;
    else if (bullet) line = `- ${bullet[1]}`; else if (/^\d+[.)]\s/.test(t)) line = t;
    if (line) { md += `${md && !md.endsWith("\n\n") ? "\n\n" : ""}${line}\n`; prev = null; continue; }
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    if (prev && gap < l.size * 1.9) md = md.replace(/-$/, "") + (md.endsWith("-") ? "" : " ") + t;
    else md += `${md ? "\n\n" : ""}${t}`;
    prev = l;
  }
  return md.trim() + "\n";
}
/** Word diff (Myers). Returns [{op: "=", "+", "-", text}] */
function diffWords(a, b) {
  const N = a.length, M = b.length, max = N + M, v = new Int32Array(2 * max + 2), trace = [];
  if (max > 120000) throw new Error("These documents are too long to compare in the browser.");
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1, y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[max + k] = x; if (x >= N && y >= M) break outer;
    }
  }
  const out = []; let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y, pk = k === -d || (k !== d && vv[max + k - 1] < vv[max + k + 1]) ? k + 1 : k - 1, px = vv[max + pk], py = px - pk;
    while (x > px && y > py) { out.push({ op: "=", text: a[--x] }); y--; }
    if (d > 0) { if (x === px) out.push({ op: "+", text: b[--y] }); else out.push({ op: "-", text: a[--x] }); }
  }
  return out.reverse();
}

/** Page n of a PDF as a canvas (for previews). */
export async function renderPdfPage(bytes, n, width) { const doc = await openJs(bytes); return (await renderPage(doc, Math.min(n, doc.numPages), width)).canvas; }

/** Every page -> one JPEG page (used by Compress PDF "Extreme" and as a rescue). */
export async function rasterize(bytes, dpi, q, onProgress = () => {}) {
  const { PDFDocument } = await pdfLib(); const js = await openJs(bytes), out = await PDFDocument.create();
  for (let p = 1; p <= js.numPages; p++) {
    onProgress(p / (js.numPages + 1));
    const vp = (await js.getPage(p)).getViewport({ scale: 1 }); const { canvas } = await renderPage(js, p, (vp.width * dpi) / 72);
    const { encodeJpeg } = await import("./codecs.js");
    const img = await out.embedJpg(new Uint8Array(await (await encodeJpeg(canvas, q)).arrayBuffer()));
    out.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
  }
  return out.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------- mount
export async function mount(panel, mode) {
  const M = MODES[mode];
  if (!M) { panel.textContent = "Unknown tool"; return; }
  return M(panel);
}

const MODES = {
  "merge-pdf": (panel) => fileList(panel, {
    accept: "application/pdf,.pdf,image/*", title: "Drop PDFs (and images) here", sub: "Put them in order with the arrows", cta: "Merge files",
    build: async (files, set) => {
      const { PDFDocument } = await pdfLib(); const out = await PDFDocument.create();
      for (const [i, f] of files.entries()) {
        set(`Adding ${i + 1} of ${files.length}…`);
        if (f.type.startsWith("image/")) { await imageToPdfPage(out, f, { size: "a4", margin: 24 }); continue; }
        const src = await openLib(await readBytes(f)); (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      }
      set("Saving…"); return { name: "merged.pdf", blob: pdfBlob(await out.save({ useObjectStreams: true })), extra: `${out.getPageCount()} pages` };
    },
  }),

  "split-pdf": (panel) => {
    let how = "each", every = 1, ranges = "";
    const s = singlePdf(panel, {
      cta: "Split PDF",
      onLoad: async ({ bytes, opts }) => {
        const n = (await openLib(bytes)).getPageCount();
        const ev = input("number", 2, { min: 1, max: n }); ev.style.width = "90px"; ev.oninput = () => (every = +ev.value || 1);
        const rg = input("text", `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}`); rg.oninput = () => (ranges = rg.value); ranges = rg.value;
        const evWrap = field("Pages per file", ev), rgWrap = field("Ranges", rg); evWrap.hidden = rgWrap.hidden = true;
        opts.replaceChildren(field("Split", segmented([["each", "Every page"], ["every", "Every N pages"], ["ranges", "Custom ranges"]], how, (v) => { how = v; evWrap.hidden = v !== "every"; rgWrap.hidden = v !== "ranges"; }).el), evWrap, rgWrap, el("p", "hint", `${n} pages. Ranges look like 1-3, 4, 7-${n}.`));
        every = 2;
      },
      build: async ({ file, bytes, set }) => {
        const { PDFDocument } = await pdfLib(); const src = await openLib(bytes), n = src.getPageCount();
        const groups = how === "each" ? Array.from({ length: n }, (_, i) => [i, i]) : how === "every" ? Array.from({ length: Math.ceil(n / every) }, (_, i) => [i * every, Math.min(n, (i + 1) * every) - 1]) : parseRanges(ranges, n);
        const files = [];
        for (const [k, [a, b]] of groups.entries()) {
          set(`Making file ${k + 1} of ${groups.length}…`);
          const out = await PDFDocument.create(); (await out.copyPages(src, Array.from({ length: b - a + 1 }, (_, i) => a + i))).forEach((p) => out.addPage(p));
          files.push({ name: `${baseName(file.name)}_${a + 1 === b + 1 ? a + 1 : `${a + 1}-${b + 1}`}.pdf`, blob: pdfBlob(await out.save({ useObjectStreams: true })) });
        }
        if (files.length === 1) return files[0];
        const zip = await downloadZip(files, `${baseName(file.name)}_split.zip`, false);
        return { name: `${baseName(file.name)}_split.zip`, blob: zip, extra: `${files.length} PDFs in a zip` };
      },
    });
    return s;
  },

  "organize-pdf": (panel) => gridTool(panel, "organize", "Save PDF", "Drag pages to reorder. ⟳ rotates, ✕ removes."),
  "remove-pages": (panel) => gridTool(panel, "remove", "Remove selected pages", "Click the pages you want to delete."),
  "rotate-pdf": (panel) => gridTool(panel, "rotate", "Save rotated PDF", "Click a page to turn it 90°, or rotate all at once."),
  "extract-pages": (panel) => gridTool(panel, "extract", "Extract selected pages", "Click the pages you want to keep in the new PDF."),

  "jpg-to-pdf": (panel) => {
    let size = "a4", orient = "auto", margin = 24;
    return fileList(panel, {
      accept: "image/*", title: "Drop images here", sub: "JPG, PNG, WebP, HEIC (Safari)", cta: "Convert to PDF",
      extraOpts: (o) => o.append(field("Page size", segmented([["a4", "A4"], ["letter", "Letter"], ["fit", "Same as image"]], size, (v) => (size = v)).el), field("Orientation", segmented([["auto", "Auto"], ["portrait", "Portrait"], ["landscape", "Landscape"]], orient, (v) => (orient = v)).el), field("Margin", segmented([[0, "None"], [24, "Small"], [56, "Large"]], margin, (v) => (margin = v)).el)),
      build: async (files, set) => {
        const { PDFDocument } = await pdfLib(); const out = await PDFDocument.create();
        for (const [i, f] of files.entries()) { set(`Adding image ${i + 1} of ${files.length}…`); await imageToPdfPage(out, f, { size, orient, margin }); }
        return { name: files.length === 1 ? `${baseName(files[0].name)}.pdf` : "images.pdf", blob: pdfBlob(await out.save({ useObjectStreams: true })), extra: `${files.length} pages` };
      },
    });
  },

  "scan-to-pdf": (panel) => {
    let look = "auto", size = "a4";
    const take = input("file", "", { accept: "image/*", capture: "environment", hidden: true });
    const r = fileList(panel, {
      accept: "image/*", title: "Take or choose photos of your documents", sub: "On a phone, this opens the camera", cta: "Make PDF",
      extraOpts: (o) => o.append(field("Look", segmented([["auto", "Clean document"], ["bw", "Black & white"], ["color", "Original color"]], look, (v) => (look = v)).el), field("Page size", segmented([["a4", "A4"], ["letter", "Letter"]], size, (v) => (size = v)).el)),
      build: async (files, set) => {
        const { PDFDocument } = await pdfLib(); const out = await PDFDocument.create();
        for (const [i, f] of files.entries()) { set(`Cleaning page ${i + 1} of ${files.length}…`); await imageToPdfPage(out, f, { size, margin: 0, filter: docFilter(look) }); }
        return { name: `scan_${new Date().toISOString().slice(0, 10)}.pdf`, blob: pdfBlob(await out.save({ useObjectStreams: true })), extra: `${files.length} pages` };
      },
    });
    const dz = panel.querySelector(".drop"); dz.querySelector("input").setAttribute("capture", "environment");
    panel.insertBefore(el("p", "hint", "Tip: lay the page on a dark surface, in good light, and fill the frame."), dz.nextSibling);
    void take; return r;
  },

  "repair-pdf": (panel) => singlePdf(panel, {
    cta: "Repair PDF",
    build: async ({ file, bytes, set }) => {
      const { PDFDocument } = await pdfLib();
      set("Rebuilding the file structure…");
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
        if (!doc.getPageCount()) throw new Error("no pages");
        return { name: `${baseName(file.name)}_repaired.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })), extra: `${doc.getPageCount()} pages rebuilt` };
      } catch {
        set("Deep repair: rescuing each page…");
        const js = await openJs(bytes), out = await PDFDocument.create(); let ok = 0;
        for (let p = 1; p <= js.numPages; p++) {
          try { const vp = (await js.getPage(p)).getViewport({ scale: 1 }); const { canvas } = await renderPage(js, p, vp.width * 2); const img = await out.embedJpg(new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9))).arrayBuffer())); out.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height }); ok++; } catch {}
        }
        if (!ok) throw new Error("Sorry, this file is too damaged to rescue.");
        return { name: `${baseName(file.name)}_rescued.pdf`, blob: pdfBlob(await out.save()), extra: `${ok} pages rescued as images` };
      }
    },
  }),

  "pdf-to-jpg": (panel) => {
    let dpi = 150, fmt = "image/jpeg", range = "";
    return singlePdf(panel, {
      cta: "Convert to images",
      onLoad: async ({ bytes, opts }) => {
        const n = (await openJs(bytes)).numPages; const rg = input("text", `1-${n}`); rg.oninput = () => (range = rg.value); range = rg.value;
        opts.replaceChildren(field("Quality", segmented([[72, "Screen"], [150, "Standard"], [300, "Print (300 dpi)"]], dpi, (v) => (dpi = v)).el), field("Format", segmented([["image/jpeg", "JPG"], ["image/png", "PNG"]], fmt, (v) => (fmt = v)).el), field("Pages", rg));
      },
      build: async ({ file, bytes, set }) => {
        const doc = await openJs(bytes), list = parseRanges(range, doc.numPages).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i + 1));
        const files = [];
        for (const [k, p] of list.entries()) {
          set(`Rendering page ${p} (${k + 1} of ${list.length})…`);
          const vp = (await doc.getPage(p)).getViewport({ scale: 1 }); const { canvas } = await renderPage(doc, p, (vp.width * dpi) / 72);
          files.push({ name: `${baseName(file.name)}_page${p}.${fmt === "image/png" ? "png" : "jpg"}`, blob: await new Promise((r) => canvas.toBlob(r, fmt, 0.92)) });
        }
        if (files.length === 1) return files[0];
        const zip = await downloadZip(files, `${baseName(file.name)}_images.zip`, false);
        return { name: `${baseName(file.name)}_images.zip`, blob: zip, extra: `${files.length} images in a zip` };
      },
    });
  },

  "pdf-to-markdown": (panel) => {
    const out = el("textarea", "mdout"); out.hidden = true; out.rows = 16;
    const s = singlePdf(panel, {
      cta: "Convert to Markdown",
      build: async ({ file, bytes, set }) => {
        const md = await toMarkdown(await openJs(bytes), set);
        if (md.trim().length < 2) throw new Error("No text found. If this is a scan, use OCR PDF first.");
        out.value = md; out.hidden = false;
        return { name: `${baseName(file.name)}.md`, blob: new Blob([md], { type: "text/markdown" }), extra: `${md.split(/\s+/).length} words` };
      },
    });
    s.work.append(out); return s;
  },

  "ocr-pdf": (panel) => {
    let lang = "eng"; const text = el("textarea", "mdout"); text.hidden = true; text.rows = 12;
    const LANGS = [["eng", "English"], ["fra", "French"], ["spa", "Spanish"], ["por", "Portuguese"], ["deu", "German"], ["ita", "Italian"], ["nld", "Dutch"], ["ara", "Arabic"], ["chi_sim", "Chinese"], ["hin", "Hindi"]];
    const opts = el("div", "opts"), st = status(), res = resultBox(), go = button("Recognize text", "btn btn--primary btn--lg"); go.disabled = true;
    const sel = select(LANGS, lang); sel.onchange = () => (lang = sel.value); opts.append(field("Document language", sel));
    let file = null; const head = el("div", "jobs");
    const dz = dropzone({ accept: "application/pdf,.pdf,image/*", title: "Drop a scanned PDF or a photo of text", sub: "Makes it searchable and copyable", onFiles: ([f]) => { file = f; const r = jobRow(f.name, f.type.startsWith("image/") ? "IMG" : "PDF"); r.progress(null); r.meta(fmtBytes(f.size)); head.replaceChildren(r.el); go.disabled = false; } });
    const actions = el("div", "row-end"); actions.append(go);
    panel.append(dz, head, opts, el("p", "hint", "Runs on your device. The first run downloads the language data (about 10 MB)."), actions, st, res, text);
    go.addEventListener("click", async () => {
      go.disabled = true; res.replaceChildren();
      try {
        st.set("Loading the text recognizer…");
        const T = await import(TESS), createWorker = T.createWorker || T.default?.createWorker; const worker = await createWorker(lang, 1, { logger: (m) => m.status === "recognizing text" && st.set(`Recognizing… ${Math.round(m.progress * 100)}%`) });
        const canvases = [];
        if (file.type.startsWith("image/")) { const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); const c = Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height }); c.getContext("2d").drawImage(bmp, 0, 0); canvases.push(c); }
        else { const doc = await openJs(await readBytes(file)); for (let p = 1; p <= doc.numPages; p++) { st.set(`Preparing page ${p} of ${doc.numPages}…`); const vp = (await doc.getPage(p)).getViewport({ scale: 1 }); canvases.push((await renderPage(doc, p, vp.width * 3)).canvas); } }
        const { PDFDocument } = await pdfLib(); const merged = await PDFDocument.create(); let all = "";
        for (const [i, c] of canvases.entries()) {
          st.set(`Recognizing page ${i + 1} of ${canvases.length}…`);
          const { data } = await worker.recognize(c, {}, { text: true, pdf: true });
          all += `${i ? "\n\n" : ""}${data.text}`;
          const part = await PDFDocument.load(new Uint8Array(data.pdf)); (await merged.copyPages(part, part.getPageIndices())).forEach((p) => merged.addPage(p));
        }
        await worker.terminate();
        text.value = all.trim(); text.hidden = false;
        showResult(res, `${baseName(file.name)}_searchable.pdf`, pdfBlob(await merged.save({ useObjectStreams: true })), `${all.split(/\s+/).filter(Boolean).length} words found`);
        const r2 = jobRow(`${baseName(file.name)}.txt`, "TXT"); r2.progress(null); r2.meta("Plain text"); r2.actions(button("Copy", "btn btn--ghost btn--sm", () => navigator.clipboard.writeText(text.value).then(() => toast("Copied"))), button("Download", "btn btn--primary btn--sm", () => download(new Blob([text.value], { type: "text/plain" }), `${baseName(file.name)}.txt`)));
        res.append(r2.el);
      } catch (e) { console.error(e); toast(e.message || "OCR failed", 5000); }
      finally { st.set(""); go.disabled = false; }
    });
  },

  "edit-pdf": (panel) => editorTool(panel, "edit", "Save PDF"),
  "sign-pdf": (panel) => editorTool(panel, "sign", "Save signed PDF"),
  "redact-pdf": (panel) => editorTool(panel, "redact", "Apply redactions"),

  "page-numbers": (panel) => {
    let pos = "bc", fmt = "n", start = 1, size = 11, skipFirst = false;
    const st0 = input("number", 1, { min: 0 }); st0.style.width = "90px"; st0.oninput = () => (start = +st0.value || 1);
    const sz = input("number", 11, { min: 6, max: 40 }); sz.style.width = "90px"; sz.oninput = () => (size = +sz.value || 11);
    const skip = el("label", "check", '<input type="checkbox" /> Skip the first page'); skip.firstChild.onchange = (e) => (skipFirst = e.target.checked);
    return singlePdf(panel, {
      cta: "Add page numbers",
      onLoad: ({ opts }) => opts.replaceChildren(
        field("Position", segmented([["bl", "↙"], ["bc", "↓"], ["br", "↘"], ["tl", "↖"], ["tc", "↑"], ["tr", "↗"]], pos, (v) => (pos = v)).el),
        field("Style", segmented([["n", "1"], ["page", "Page 1"], ["of", "Page 1 of 9"], ["slash", "1 / 9"]], fmt, (v) => (fmt = v)).el),
        field("Start at", st0), field("Size", sz), skip),
      build: async ({ file, bytes }) => {
        const { StandardFonts, rgb } = await pdfLib(); const doc = await openLib(bytes), font = await doc.embedFont(StandardFonts.Helvetica), pages = doc.getPages(), total = pages.length - (skipFirst ? 1 : 0) + start - 1;
        pages.forEach((p, i) => {
          if (skipFirst && i === 0) return; const num = i - (skipFirst ? 1 : 0) + start;
          const label = fmt === "n" ? `${num}` : fmt === "page" ? `Page ${num}` : fmt === "of" ? `Page ${num} of ${total}` : `${num} / ${total}`;
          const { width, height, x: bx, y: by } = p.getCropBox(), tw = font.widthOfTextAtSize(label, size), m = 28;
          const x = bx + (pos[1] === "l" ? m : pos[1] === "r" ? width - m - tw : (width - tw) / 2), y = by + (pos[0] === "b" ? m - size / 2 : height - m);
          p.drawText(label, { x, y, size, font, color: rgb(0.2, 0.2, 0.25) });
        });
        return { name: `${baseName(file.name)}_numbered.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })) };
      },
    });
  },

  "watermark-pdf": (panel) => {
    let text = "CONFIDENTIAL", size = 60, opacity = 0.18, angle = 45, color = "#ef4444", tiled = false;
    const t = input("text", text); t.oninput = () => (text = t.value);
    const sz = input("range", size, { min: 16, max: 140 }); sz.oninput = () => (size = +sz.value);
    const op = input("range", opacity * 100, { min: 5, max: 80 }); op.oninput = () => (opacity = +op.value / 100);
    const col = input("color", color); col.oninput = () => (color = col.value);
    const tl = el("label", "check", '<input type="checkbox" /> Repeat across the page'); tl.firstChild.onchange = (e) => (tiled = e.target.checked);
    return singlePdf(panel, {
      cta: "Add watermark",
      onLoad: ({ opts }) => opts.replaceChildren(field("Text", t), field("Size", sz), field("Opacity", op), field("Angle", segmented([[45, "Diagonal"], [0, "Flat"], [-45, "Other diagonal"]], angle, (v) => (angle = v)).el), field("Color", col), tl),
      build: async ({ file, bytes }) => {
        if (!text.trim()) throw new Error("Type the watermark text");
        const { StandardFonts, rgb, degrees } = await pdfLib(); const doc = await openLib(bytes), font = await doc.embedFont(StandardFonts.HelveticaBold);
        const c = color.match(/\w\w/g).map((v) => parseInt(v, 16) / 255), clean = text.replace(/[^\x20-\xFF]/g, "");
        for (const p of doc.getPages()) {
          const { width, height, x: bx, y: by } = p.getCropBox(), tw = font.widthOfTextAtSize(clean, size), rad = (angle * Math.PI) / 180;
          const put = (cx, cy) => p.drawText(clean, { x: cx - (Math.cos(rad) * tw) / 2 + (Math.sin(rad) * size) / 3, y: cy - (Math.sin(rad) * tw) / 2 - (Math.cos(rad) * size) / 3, size, font, color: rgb(...c), opacity, rotate: degrees(angle) });
          if (!tiled) put(bx + width / 2, by + height / 2);
          else for (let y = by + size; y < by + height; y += size * 3.2) for (let x = bx + tw / 2 - ((y / size) % 2) * tw / 2; x < bx + width + tw; x += tw + size * 1.5) put(x, y);
        }
        return { name: `${baseName(file.name)}_watermarked.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })) };
      },
    });
  },

  "crop-pdf": (panel) => {
    const m = { t: 5, r: 5, b: 5, l: 5 }; let preview = null;
    const box = el("div", "cropbox"); const frame = el("div", "cropframe");
    const sliders = Object.entries({ t: "Top", r: "Right", b: "Bottom", l: "Left" }).map(([k, label]) => { const s = input("range", m[k], { min: 0, max: 40 }); s.oninput = () => { m[k] = +s.value; draw(); }; return field(`${label} %`, s); });
    const draw = () => Object.assign(frame.style, { top: `${m.t}%`, right: `${m.r}%`, bottom: `${m.b}%`, left: `${m.l}%` });
    const s = singlePdf(panel, {
      cta: "Crop all pages",
      onLoad: async ({ bytes, opts }) => { opts.replaceChildren(...sliders); const doc = await openJs(bytes); preview = (await renderPage(doc, 1, 320)).canvas; box.replaceChildren(preview, frame); draw(); },
      build: async ({ file, bytes }) => {
        if (m.t + m.b >= 95 || m.l + m.r >= 95) throw new Error("That would crop away the whole page");
        const doc = await openLib(bytes);
        for (const p of doc.getPages()) {
          const { x, y, width, height } = p.getCropBox(), rot = p.getRotation().angle % 360;
          // margins are as seen on screen; map them to the page's own orientation
          let [T, R, B, L] = [m.t, m.r, m.b, m.l].map((v) => v / 100);
          if (rot === 90) [T, R, B, L] = [L, T, R, B]; else if (rot === 180) [T, R, B, L] = [B, L, T, R]; else if (rot === 270) [T, R, B, L] = [R, B, L, T];
          const box = [x + L * width, y + B * height, width * (1 - L - R), height * (1 - T - B)];
          p.setCropBox(...box); p.setMediaBox(...box);
        }
        return { name: `${baseName(file.name)}_cropped.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })) };
      },
    });
    s.opts.after(box); return s;
  },

  "pdf-forms": (panel) => {
    let flatten = false, fields = [];
    const s = singlePdf(panel, {
      cta: "Save filled PDF",
      onLoad: async ({ bytes, opts }) => {
        const doc = await openLib(bytes); const form = doc.getForm(); fields = form.getFields();
        opts.className = "formfields";
        if (!fields.length) { opts.innerHTML = `<p class="hint">This PDF has no fillable fields. Use <a href="#/edit-pdf">Edit PDF</a> to type on it instead.</p>`; return; }
        opts.replaceChildren(...fields.map((f) => {
          const kind = f.constructor.name, name = f.getName(); let ctl;
          if (/TextField/.test(kind)) { ctl = input("text", f.getText() || ""); if (f.isMultiline?.()) { ctl = el("textarea"); ctl.value = f.getText() || ""; } }
          else if (/CheckBox/.test(kind)) { ctl = el("label", "check", `<input type="checkbox" ${f.isChecked() ? "checked" : ""}/> Yes`); }
          else if (/Dropdown|OptionList/.test(kind)) { ctl = select([["", "—"], ...f.getOptions().map((o) => [o, o])], (f.getSelected() || [])[0] || ""); }
          else if (/RadioGroup/.test(kind)) { ctl = select([["", "—"], ...f.getOptions().map((o) => [o, o])], f.getSelected() || ""); }
          else return el("p", "hint", `${esc(name)}: this kind of field can't be filled here`);
          ctl.dataset.field = name; return field(name.replace(/[_.]+/g, " "), ctl);
        }), el("label", "check", '<input type="checkbox" data-flat /> Lock the answers (flatten)'));
        opts.querySelector("[data-flat]").onchange = (e) => (flatten = e.target.checked);
      },
      build: async ({ file, bytes }) => {
        const doc = await openLib(bytes), form = doc.getForm();
        panel.querySelectorAll("[data-field]").forEach((ctl) => {
          const f = form.getField(ctl.dataset.field), kind = f.constructor.name, cb = ctl.querySelector?.("input[type=checkbox]");
          try {
            if (/TextField/.test(kind)) f.setText(ctl.value);
            else if (/CheckBox/.test(kind)) cb.checked ? f.check() : f.uncheck();
            else if (ctl.value) f.select(ctl.value);
          } catch (e) { console.warn(e); }
        });
        if (flatten) form.flatten();
        return { name: `${baseName(file.name)}_filled.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })) };
      },
    });
    return s;
  },

  "protect-pdf": (panel) => {
    const pw = input("password", "", { placeholder: "At least 4 characters", autocomplete: "new-password" }), pw2 = input("password", "", { autocomplete: "new-password" });
    let print = true, copy = true;
    const pc = el("label", "check", '<input type="checkbox" checked /> Allow printing'), cc = el("label", "check", '<input type="checkbox" checked /> Allow copying text');
    pc.firstChild.onchange = (e) => (print = e.target.checked); cc.firstChild.onchange = (e) => (copy = e.target.checked);
    return singlePdf(panel, {
      cta: "Protect PDF",
      onLoad: ({ opts }) => opts.replaceChildren(field("Password", pw), field("Repeat password", pw2), pc, cc),
      build: async ({ file, bytes, set }) => {
        if (pw.value.length < 4) throw new Error("Use a password of at least 4 characters");
        if (pw.value !== pw2.value) throw new Error("The passwords don't match");
        set("Encrypting with AES-256…");
        const owner = crypto.getRandomValues(new Uint32Array(4)).join("-");
        const out = await runQpdf(bytes, ["IN", "--encrypt", pw.value, owner, "256", ...(print ? [] : ["--print=none"]), ...(copy ? [] : ["--extract=n"]), "--", "OUT"]);
        return { name: `${baseName(file.name)}_protected.pdf`, blob: pdfBlob(out), extra: "Don't forget the password: it can't be recovered" };
      },
    });
  },

  "unlock-pdf": (panel) => {
    const pw = input("password", "", { placeholder: "The PDF's password", autocomplete: "current-password" });
    return singlePdf(panel, {
      cta: "Unlock PDF",
      onLoad: ({ opts }) => opts.replaceChildren(field("Password", pw), el("p", "hint", "Leave empty if the PDF opens without a password but blocks printing or copying.")),
      build: async ({ file, bytes, set }) => {
        set("Removing the password…");
        try { return { name: `${baseName(file.name)}_unlocked.pdf`, blob: pdfBlob(await runQpdf(bytes, [...(pw.value ? [`--password=${pw.value}`] : []), "--decrypt", "IN", "OUT"])) }; }
        catch (e) { throw new Error(/password/i.test(e.message) ? "That password isn't right." : "Couldn't unlock this PDF."); }
      },
    });
  },

  "compare-pdf": (panel) => {
    const files = [null, null], out = el("div", "diffout"), st = status(), go = button("Compare", "btn btn--primary btn--lg"); go.disabled = true;
    const wrap = el("div", "two");
    ["Original", "New version"].forEach((label, i) => {
      const box = el("div"); const info = el("div", "jobs");
      box.append(dropzone({ accept: "application/pdf,.pdf", title: label, sub: "Drop a PDF", onFiles: ([f]) => { files[i] = f; const r = jobRow(f.name, "PDF"); r.progress(null); r.meta(fmtBytes(f.size)); info.replaceChildren(r.el); go.disabled = !(files[0] && files[1]); } }), info);
      wrap.append(box);
    });
    const actions = el("div", "row-end"); actions.append(go);
    panel.append(wrap, actions, st, out);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const words = [];
        for (const f of files) { st.set(`Reading ${f.name}…`); const doc = await openJs(await readBytes(f)); const w = []; for (let p = 1; p <= doc.numPages; p++) w.push(...(await pageLines(doc, p)).flatMap((l) => l.text.split(/\s+/))); words.push(w); }
        st.set("Comparing…"); await new Promise((r) => setTimeout(r, 30));
        const d = diffWords(words[0], words[1]), add = d.filter((x) => x.op === "+").length, del = d.filter((x) => x.op === "-").length;
        // compact view: show changes with a little context
        const html = []; let lastShown = -1;
        d.forEach((x, i) => {
          if (x.op === "=") { const near = d.slice(Math.max(0, i - 6), i + 7).some((y) => y.op !== "="); if (near) { if (lastShown < i - 1 && lastShown !== -1) html.push('<span class="gap">…</span>'); html.push(esc(x.text)); lastShown = i; } return; }
          if (lastShown < i - 1 && lastShown !== -1) html.push('<span class="gap">…</span>');
          html.push(x.op === "+" ? `<ins>${esc(x.text)}</ins>` : `<del>${esc(x.text)}</del>`); lastShown = i;
        });
        out.innerHTML = add + del === 0 ? `<p class="ok">No text differences found.</p>` : `<p class="hint"><ins>${add} words added</ins> · <del>${del} words removed</del></p><div class="diff">${html.join(" ")}</div>`;
      } catch (e) { toast(e.message, 5000); }
      finally { st.set(""); go.disabled = false; }
    });
  },
};

function gridTool(panel, mode, cta, help) {
  let grid = null;
  const s = singlePdf(panel, {
    cta, title: "Drop a PDF here or click to choose",
    onLoad: async ({ bytes, opts }) => {
      const area = el("div"); opts.replaceChildren(el("p", "hint", help));
      if (mode === "rotate") opts.append(button("⟳ Rotate all", "btn btn--ghost btn--sm", () => grid.all((p) => (p.rot = (p.rot + 90) % 360))));
      if (mode === "extract") opts.append(button("Select all", "btn btn--ghost btn--sm", () => grid.all((p) => (p.sel = true))), button("Clear", "btn btn--ghost btn--sm", () => grid.all((p) => (p.sel = false))));
      opts.after(area); grid = await pageGrid(area, bytes, { mode, set: s.st.set });
    },
    build: async ({ file, bytes, set }) => {
      let list = grid.order();
      if (mode === "extract") list = list.filter((p) => p.sel); else list = list.filter((p) => !p.del);
      if (!list.length) throw new Error(mode === "extract" ? "Pick at least one page" : "You can't remove every page");
      set("Saving…");
      const suffix = { organize: "organized", remove: "trimmed", rotate: "rotated", extract: "extract" }[mode];
      return { name: `${baseName(file.name)}_${suffix}.pdf`, blob: pdfBlob(await rebuild(bytes, list)), extra: `${list.length} pages` };
    },
  });
  return s;
}

function editorTool(panel, kind, cta) {
  let ed = null;
  const s = singlePdf(panel, {
    cta,
    onLoad: async ({ bytes, opts }) => { opts.replaceChildren(); const area = el("div"); opts.after(area); s.st.set("Opening…"); ed = await pageEditor(area, bytes, kind, s.st.set); s.st.set(""); },
    build: async ({ file, set }) => ({ name: `${baseName(file.name)}_${{ edit: "edited", sign: "signed", redact: "redacted" }[kind]}.pdf`, blob: pdfBlob(await ed.build(set)) }),
  });
  return s;
}
