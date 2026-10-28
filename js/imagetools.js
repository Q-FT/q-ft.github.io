// Image toolbox: photo editor, background remover, blur background, face cutout, passport photo, sketch,
// vectorizer, blur & pixelate areas, watermark photos, remove metadata, compress to an exact size.
// People cutouts use MODNet (Apache-2.0) through ONNX Runtime Web. Everything runs in the browser.
import { $, esc, fmtBytes, baseName, extOf, dropzone, segmented, opt, jobRow, button, download, downloadZip, toast } from "./ui.js";
import { session } from "./ort.js";
import { encodeJpeg } from "./codecs.js";

const MODNET = "models/modnet.onnx";
const el = (tag, cls, html) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, html != null ? { innerHTML: html } : {});
const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
const input = (type, value, attrs = {}) => Object.assign(document.createElement("input"), { type, value, ...attrs });
const toBlob = (c, type = "image/png", q = 0.92) => new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("Couldn't save the image"))), type, q));
const status = () => { const s = el("div", "status"); s.hidden = true; s.set = (m) => { s.hidden = !m; s.innerHTML = m ? `<span class="spin"></span>${esc(m)}` : ""; }; return s; };
const range = (label, min, max, value, on, step = 1) => { const r = input("range", value, { min, max, step }); r.addEventListener("input", () => on(+r.value)); return opt(label, r); };

async function loadImage(file, maxSide = 0) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
  const c = canvas(bmp.width * k, bmp.height * k); const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return c;
}

/** Fast, smooth blur that works in every browser (downscale + upscale, twice). radius ~ px */
function blurCanvas(src, radius) {
  if (radius < 0.5) return src;
  // shrink, then grow back in two smooth steps: a soft blur with clean edges, same in every browser
  const k = Math.max(1.5, radius / 1.5), small = canvas(src.width / k, src.height / k), sg = small.getContext("2d");
  sg.imageSmoothingQuality = "high"; sg.drawImage(src, 0, 0, small.width, small.height);
  const mid = canvas(small.width * 2, small.height * 2), mg = mid.getContext("2d"); mg.imageSmoothingQuality = "high"; mg.drawImage(small, 0, 0, mid.width, mid.height);
  const out = canvas(src.width, src.height), g = out.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(mid, 0, 0, out.width, out.height);
  return out;
}

// ---------------------------------------------------------------- MODNet: people matte
async function personMatte(src, set) {
  const { ort, s } = await session(MODNET, set, "cutout model (26 MB)", 25_888_640);
  set("Finding the person…");
  // MODNet works best around 512 px on the short side, sizes divisible by 32
  const k = 512 / Math.min(src.width, src.height), w = Math.max(32, Math.round((src.width * Math.min(k, 1024 / Math.max(src.width, src.height) * Math.max(1, k))) / 32) * 32);
  const h = Math.max(32, Math.round((w * src.height) / src.width / 32) * 32);
  const c = canvas(w, h), g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, n = w * h, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 127.5 - 1; x[n + i] = d[i * 4 + 1] / 127.5 - 1; x[2 * n + i] = d[i * 4 + 2] / 127.5 - 1; }
  const out = await s.run({ input: new ort.Tensor("float32", x, [1, 3, h, w]) });
  const m = out.output.data, mc = canvas(w, h), mg = mc.getContext("2d"), md = mg.createImageData(w, h);
  for (let i = 0; i < n; i++) { md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255; md.data[i * 4 + 3] = Math.min(255, Math.max(0, (m[i] - 0.02) * 270)); }
  mg.putImageData(md, 0, 0);
  const full = canvas(src.width, src.height), fg = full.getContext("2d"); fg.imageSmoothingQuality = "high"; fg.drawImage(mc, 0, 0, full.width, full.height);
  return full; // white, alpha = person
}
function cutout(src, matte) { const c = canvas(src.width, src.height), g = c.getContext("2d"); g.drawImage(src, 0, 0); g.globalCompositeOperation = "destination-in"; g.drawImage(matte, 0, 0); return c; }
function alphaBox(c, thr = 128) {
  const { data, width: W, height: H } = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (data[(y * W + x) * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- shared single-image workspace
function workspace(panel, { title = "Drop a photo here or click to choose", sub = "JPG, PNG, WebP, HEIC (Safari)", maxSide = 4096, onImage }) {
  const st = status(), opts = el("div", "opts"), view = el("div", "imgview"), actions = el("div", "row-end");
  const work = el("div"); work.hidden = true;
  const change = button("Choose another photo", "btn btn--ghost", () => { work.hidden = true; dz.hidden = false; });
  actions.append(change);
  work.append(opts, st, view, actions);
  const ctx = { file: null, src: null, st, opts, view, actions, work };
  const dz = dropzone({ accept: "image/*", title, sub, onFiles: async ([f]) => {
    try { ctx.file = f; st.set("Opening…"); ctx.src = await loadImage(f, maxSide); dz.hidden = true; work.hidden = false; opts.replaceChildren(); view.replaceChildren(); actions.replaceChildren(change); await onImage(ctx); }
    catch (e) { console.error(e); toast(e.message || "Couldn't open that image", 5000); }
    finally { st.set(""); }
  } });
  panel.append(dz, work);
  return ctx;
}
function showCanvas(view, c, checker = false) { const w = el("div", `imgbox${checker ? " imgbox--alpha" : ""}`); w.append(c); view.replaceChildren(w); return w; }
function saveButtons(ctx, getCanvas, { name, png = true, jpg = true }) {
  const btns = [];
  if (jpg) btns.push(button("Download JPG", png ? "btn btn--ghost" : "btn btn--primary", async () => { const c = getCanvas(); const flat = canvas(c.width, c.height), g = flat.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0); download(await encodeJpeg(flat, 90), `${name}.jpg`); }));
  if (png) btns.push(button("Download PNG", "btn btn--primary", async () => download(await toBlob(getCanvas(), "image/png"), `${name}.png`)));
  ctx.actions.append(...btns);
}

// ---------------------------------------------------------------- pixel helpers for the editor / sketch
function adjust(src, a) {
  const c = canvas(src.width, src.height), g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  const br = a.brightness / 100, ct = (a.contrast + 100) / 100, sat = (a.saturation + 100) / 100, warm = a.warmth / 100 * 30;
  const cx = c.width / 2, cy = c.height / 2, vmax = Math.hypot(cx, cy), vig = a.vignette / 100;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let r = d[i], gg = d[i + 1], b = d[i + 2];
    r += br * 255; gg += br * 255; b += br * 255;
    r = (r - 128) * ct + 128; gg = (gg - 128) * ct + 128; b = (b - 128) * ct + 128;
    const l = 0.299 * r + 0.587 * gg + 0.114 * b; r = l + (r - l) * sat; gg = l + (gg - l) * sat; b = l + (b - l) * sat;
    r += warm; b -= warm;
    if (a.filter === "bw") r = gg = b = 0.299 * r + 0.587 * gg + 0.114 * b;
    else if (a.filter === "sepia") { const t = 0.299 * r + 0.587 * gg + 0.114 * b; r = t * 1.07 + 18; gg = t * 0.92 + 8; b = t * 0.72; }
    else if (a.filter === "vivid") { const t = 0.299 * r + 0.587 * gg + 0.114 * b; r = t + (r - t) * 1.35; gg = t + (gg - t) * 1.35; b = t + (b - t) * 1.35; }
    else if (a.filter === "cool") { r -= 12; b += 16; } else if (a.filter === "fade") { r = r * 0.85 + 30; gg = gg * 0.85 + 30; b = b * 0.85 + 34; }
    if (vig) { const x = p % c.width, y = (p / c.width) | 0, f = 1 - vig * Math.pow(Math.hypot(x - cx, y - cy) / vmax, 2.2); r *= f; gg *= f; b *= f; }
    d[i] = r; d[i + 1] = gg; d[i + 2] = b;
  }
  g.putImageData(img, 0, 0);
  if (a.blur > 0) return blurCanvas(c, a.blur);
  if (a.sharpen > 0) { // unsharp mask
    const bl = blurCanvas(c, 1.5).getContext("2d").getImageData(0, 0, c.width, c.height).data, o = g.getImageData(0, 0, c.width, c.height), k = a.sharpen / 50;
    for (let i = 0; i < o.data.length; i += 4) for (let j = 0; j < 3; j++) o.data[i + j] = o.data[i + j] + (o.data[i + j] - bl[i + j]) * k;
    g.putImageData(o, 0, 0);
  }
  return c;
}
function geometry(src, { rot, flipH, flipV, crop }) {
  const sw = rot % 180 ? src.height : src.width, sh = rot % 180 ? src.width : src.height;
  const t = canvas(sw, sh), g = t.getContext("2d");
  g.translate(sw / 2, sh / 2); g.rotate((rot * Math.PI) / 180); g.scale(flipH ? -1 : 1, flipV ? -1 : 1); g.drawImage(src, -src.width / 2, -src.height / 2);
  if (!crop) return t;
  const c = canvas(crop.w * sw, crop.h * sh); c.getContext("2d").drawImage(t, crop.x * sw, crop.y * sh, c.width, c.height, 0, 0, c.width, c.height); return c;
}

/** Draggable rectangle on top of a canvas, in 0..1 coordinates. ratio = w/h in pixels or 0 for free */
function cropBox(box, c, onChange) {
  const r = el("div", "cropsel", '<i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i>'); box.append(r);
  const st = { x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: 0 };
  const draw = () => Object.assign(r.style, { left: `${st.x * 100}%`, top: `${st.y * 100}%`, width: `${st.w * 100}%`, height: `${st.h * 100}%` });
  const fix = () => {
    if (st.ratio) { const ar = c.width / c.height; st.h = Math.min(1, (st.w * ar) / st.ratio); st.w = Math.min(st.w, (st.h * st.ratio) / ar); }
    st.w = Math.min(st.w, 1); st.h = Math.min(st.h, 1); st.x = Math.max(0, Math.min(1 - st.w, st.x)); st.y = Math.max(0, Math.min(1 - st.h, st.y)); draw(); onChange?.(st);
  };
  r.addEventListener("pointerdown", (e) => {
    e.preventDefault(); r.setPointerCapture(e.pointerId); const h = e.target.dataset.h, b = box.getBoundingClientRect(); let lx = e.clientX, ly = e.clientY;
    const mv = (ev) => {
      const dx = (ev.clientX - lx) / b.width, dy = (ev.clientY - ly) / b.height; lx = ev.clientX; ly = ev.clientY;
      if (!h) { st.x += dx; st.y += dy; }
      else { if (h.includes("w")) { st.x += dx; st.w -= dx; } if (h.includes("e")) st.w += dx; if (h.includes("n")) { st.y += dy; st.h -= dy; } if (h.includes("s")) st.h += dy; st.w = Math.max(0.04, st.w); st.h = Math.max(0.04, st.h); }
      fix();
    };
    const up = () => { r.removeEventListener("pointermove", mv); r.removeEventListener("pointerup", up); };
    r.addEventListener("pointermove", mv); r.addEventListener("pointerup", up);
  });
  draw();
  return { st, setRatio(v) { st.ratio = v; if (v) { st.x = 0.05; st.w = 0.9; } fix(); }, el: r };
}

// ---------------------------------------------------------------- JPEG / PNG metadata (lossless strip)
function readExifSummary(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), found = new Set();
  if (v.getUint16(0) !== 0xffd8) return found;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const m = v.getUint16(o), len = v.getUint16(o + 2);
    if (m === 0xffe1 && String.fromCharCode(...buf.subarray(o + 4, o + 8)) === "Exif") {
      found.add("EXIF");
      const t = o + 10, le = v.getUint16(t) === 0x4949, U16 = (p) => v.getUint16(p, le), U32 = (p) => v.getUint32(p, le);
      const ifd = t + U32(t + 4), n = U16(ifd);
      for (let i = 0; i < n; i++) { const tag = U16(ifd + 2 + i * 12); if (tag === 0x8825) found.add("GPS location"); if (tag === 0x010f || tag === 0x0110) found.add("camera model"); if (tag === 0x0132) found.add("date taken"); }
    } else if (m === 0xffe1) found.add("XMP");
    else if (m === 0xffed) found.add("IPTC");
    if (m === 0xffda) break; o += 2 + len;
  }
  return found;
}
function stripJpeg(buf) {
  const parts = [buf.subarray(0, 2)]; let o = 2;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (o + 4 <= buf.length) {
    const m = v.getUint16(o); if (m === 0xffda) { parts.push(buf.subarray(o)); break; }
    const len = v.getUint16(o + 2);
    // keep JFIF (APP0), Adobe (APP14, color info) and ICC profiles (APP2 "ICC_PROFILE"); drop EXIF/XMP/IPTC/comments
    const isIcc = m === 0xffe2 && String.fromCharCode(...buf.subarray(o + 4, o + 15)) === "ICC_PROFILE";
    if (!((m >= 0xffe1 && m <= 0xffef && m !== 0xffee && !isIcc) || m === 0xfffe)) parts.push(buf.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  return new Blob(parts, { type: "image/jpeg" });
}
function stripPng(buf) {
  const parts = [buf.subarray(0, 8)]; let o = 8; const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), found = new Set();
  while (o + 8 <= buf.length) {
    const len = v.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    if (["tEXt", "iTXt", "zTXt", "eXIf", "tIME"].includes(type)) found.add(type === "eXIf" ? "EXIF" : "text notes"); else parts.push(buf.subarray(o, o + 12 + len));
    o += 12 + len;
  }
  return { blob: new Blob(parts, { type: "image/png" }), found };
}

// ---------------------------------------------------------------- modes
const MODES = {
  "photo-editor": (panel) => workspace(panel, { onImage: (ctx) => {
    const a = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, blur: 0, sharpen: 0, filter: "none" }, geo = { rot: 0, flipH: false, flipV: false, crop: null };
    let preview = null, crop = null, cropping = false, timer;
    const small = canvas(...fit(ctx.src, 1100)); small.getContext("2d").drawImage(ctx.src, 0, 0, small.width, small.height);
    const render = () => { clearTimeout(timer); timer = setTimeout(() => { const s = (preview = adjust(geometry(small, { ...geo, crop: cropping ? null : geo.crop }), { ...a, blur: a.blur * (small.width / ctx.src.width) })); const box = showCanvas(ctx.view, s); if (cropping) { crop = cropBox(box, s); crop.setRatio(cropRatio); } }, 60); };
    let cropRatio = 0;
    const cropBar = el("div", "swatches"); cropBar.hidden = true;
    cropBar.append(segmented([[0, "Free"], [1, "1:1"], [4 / 3, "4:3"], [3 / 2, "3:2"], [16 / 9, "16:9"], [4 / 5, "4:5"], [9 / 16, "9:16"]], 0, (v) => { cropRatio = v; crop?.setRatio(v); }).el,
      button("Apply crop", "btn btn--primary btn--sm", () => { const { x, y, w, h } = crop.st; geo.crop = geo.crop ? { x: geo.crop.x + x * geo.crop.w, y: geo.crop.y + y * geo.crop.h, w: w * geo.crop.w, h: h * geo.crop.h } : { x, y, w, h }; cropping = false; cropBar.hidden = true; render(); }),
      button("Cancel", "btn btn--ghost btn--sm", () => { cropping = false; cropBar.hidden = true; render(); }));
    const tools = el("div", "swatches");
    tools.append(button("✂ Crop", "btn btn--ghost btn--sm", () => { if (geo.crop) { geo.crop = null; } cropping = true; cropBar.hidden = false; render(); }),
      button("⟲", "btn btn--ghost btn--sm", () => { geo.rot = (geo.rot + 270) % 360; geo.crop = null; render(); }), button("⟳", "btn btn--ghost btn--sm", () => { geo.rot = (geo.rot + 90) % 360; geo.crop = null; render(); }),
      button("⇆ Flip", "btn btn--ghost btn--sm", () => { geo.flipH = !geo.flipH; render(); }), button("⇅ Flip", "btn btn--ghost btn--sm", () => { geo.flipV = !geo.flipV; render(); }),
      button("Reset", "btn btn--ghost btn--sm", () => { Object.assign(a, { brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, blur: 0, sharpen: 0, filter: "none" }); Object.assign(geo, { rot: 0, flipH: false, flipV: false, crop: null }); ctx.opts.querySelectorAll("input[type=range]").forEach((r) => (r.value = 0)); render(); }));
    ctx.opts.append(opt("Tools", tools), cropBar,
      opt("Filter", segmented([["none", "None"], ["vivid", "Vivid"], ["bw", "B&W"], ["sepia", "Sepia"], ["cool", "Cool"], ["fade", "Fade"]], "none", (v) => { a.filter = v; render(); }).el),
      range("Brightness", -60, 60, 0, (v) => { a.brightness = v; render(); }), range("Contrast", -60, 80, 0, (v) => { a.contrast = v; render(); }), range("Saturation", -100, 100, 0, (v) => { a.saturation = v; render(); }),
      range("Warmth", -100, 100, 0, (v) => { a.warmth = v; render(); }), range("Vignette", 0, 80, 0, (v) => { a.vignette = v; render(); }), range("Blur", 0, 40, 0, (v) => { a.blur = v; render(); }), range("Sharpen", 0, 100, 0, (v) => { a.sharpen = v; render(); }));
    saveButtons(ctx, () => adjust(geometry(ctx.src, geo), a), { name: `${baseName(ctx.file.name)}_edited` });
    render(); void preview;
  } }),

  "remove-bg": (panel) => workspace(panel, { title: "Drop a photo of a person", sub: "Works best with people and portraits", onImage: async (ctx) => {
    const matte = await personMatte(ctx.src, ctx.st.set); ctx.st.set("");
    const cut = cutout(ctx.src, matte); let bg = "none", color = "#ffffff", out = cut;
    const col = input("color", color); col.oninput = () => { color = col.value; bg = "color"; draw(); };
    const draw = () => { out = bg === "none" ? cut : (() => { const c = canvas(cut.width, cut.height), g = c.getContext("2d"); if (bg === "blur") g.drawImage(blurCanvas(ctx.src, Math.max(8, cut.width / 80)), 0, 0); else { g.fillStyle = bg === "white" ? "#fff" : color; g.fillRect(0, 0, c.width, c.height); } g.drawImage(cut, 0, 0); return c; })(); showCanvas(ctx.view, out, bg === "none"); };
    ctx.opts.append(opt("Background", segmented([["none", "Transparent"], ["white", "White"], ["color", "Color"], ["blur", "Blurred"]], bg, (v) => { bg = v; draw(); }).el), opt("Color", col));
    saveButtons(ctx, () => out, { name: `${baseName(ctx.file.name)}_no-bg` }); draw();
  } }),

  "blur-bg": (panel) => workspace(panel, { title: "Drop a photo of a person", sub: "Portrait mode for any photo", onImage: async (ctx) => {
    const matte = await personMatte(ctx.src, ctx.st.set); ctx.st.set("");
    const cut = cutout(ctx.src, matte); let strength = 12, out;
    const draw = () => { const c = canvas(cut.width, cut.height), g = c.getContext("2d"); g.drawImage(blurCanvas(ctx.src, (strength * cut.width) / 1000), 0, 0); g.drawImage(cut, 0, 0); out = c; showCanvas(ctx.view, c); };
    ctx.opts.append(range("Blur strength", 2, 40, strength, (v) => { strength = v; draw(); }));
    saveButtons(ctx, () => out, { name: `${baseName(ctx.file.name)}_portrait`, png: false }); draw();
  } }),

  "face-cutout": (panel) => workspace(panel, { title: "Drop a photo of a person", sub: "Get a head-and-shoulders sticker", onImage: async (ctx) => {
    const matte = await personMatte(ctx.src, ctx.st.set); ctx.st.set("");
    const cut = cutout(ctx.src, matte), bb = alphaBox(cut);
    if (!bb) throw new Error("No person found in this photo");
    let shape = "circle", outline = true, ring = "#ffffff", out;
    const size = Math.round(Math.min(bb.w, bb.h * 0.9)); // head and shoulders: top part of the person
    const cx = bb.x + bb.w / 2, top = Math.max(0, bb.y - size * 0.08);
    const col = input("color", ring); col.oninput = () => { ring = col.value; draw(); };
    const draw = () => {
      const S = 1024, c = canvas(S, S), g = c.getContext("2d"), k = (S * 0.84) / size, ox = S / 2 - cx * k, oy = S * 0.08 - top * k;
      if (shape !== "free") { g.save(); g.beginPath(); if (shape === "circle") g.arc(S / 2, S / 2, S / 2 - 8, 0, 7); else g.roundRect(8, 8, S - 16, S - 16, 120); g.fillStyle = ring; g.fill(); g.clip(); g.fillStyle = "#f3f4ff"; g.beginPath(); if (shape === "circle") g.arc(S / 2, S / 2, S / 2 - (outline ? 26 : 8), 0, 7); else g.roundRect(outline ? 26 : 8, outline ? 26 : 8, S - (outline ? 52 : 16), S - (outline ? 52 : 16), 110); g.fill(); g.clip(); g.drawImage(cut, ox, oy, cut.width * k, cut.height * k); g.restore(); }
      else { if (outline) { g.shadowColor = ring; for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]]) { g.shadowOffsetX = dx; g.shadowOffsetY = dy; g.drawImage(cut, ox, oy, cut.width * k, cut.height * k); } g.shadowColor = "transparent"; } g.drawImage(cut, ox, oy, cut.width * k, cut.height * k); }
      out = c; showCanvas(ctx.view, c, true);
    };
    const oc = el("label", "check", '<input type="checkbox" checked /> Outline'); oc.firstChild.onchange = (e) => { outline = e.target.checked; draw(); };
    ctx.opts.append(opt("Shape", segmented([["circle", "Circle"], ["square", "Rounded square"], ["free", "Sticker"]], shape, (v) => { shape = v; draw(); }).el), oc, opt("Outline color", col));
    saveButtons(ctx, () => out, { name: `${baseName(ctx.file.name)}_cutout`, jpg: false }); draw();
  } }),

  "passport-photo": (panel) => workspace(panel, { title: "Drop a photo of your face", sub: "Face the camera, even light, neutral expression", onImage: async (ctx) => {
    const SIZES = { us: { label: "US 2×2 in", w: 51, h: 51, head: 0.6 }, eu: { label: "EU / UK 35×45 mm", w: 35, h: 45, head: 0.75 }, ca: { label: "Canada 50×70 mm", w: 50, h: 70, head: 0.48 }, cn: { label: "China 33×48 mm", w: 33, h: 48, head: 0.68 }, in: { label: "India 35×45 mm", w: 35, h: 45, head: 0.75 } };
    const matte = await personMatte(ctx.src, ctx.st.set); ctx.st.set("");
    const cut = cutout(ctx.src, matte), bb = alphaBox(cut); if (!bb) throw new Error("No person found in this photo");
    let key = "us", zoom = 1, dx = 0, dy = 0, out;
    const draw = () => {
      const S = SIZES[key], W = Math.round((S.w / 25.4) * 300), H = Math.round((S.h / 25.4) * 300);
      const headPx = bb.w * 0.62, k = ((H * S.head) / (headPx * 1.25)) * zoom; // head (crown to chin) ≈ 1.25 × head width
      const c = canvas(W, H), g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
      g.imageSmoothingQuality = "high"; g.drawImage(cut, W / 2 - (bb.x + bb.w / 2) * k + dx * W, H * 0.1 - bb.y * k + dy * H, cut.width * k, cut.height * k);
      out = c;
      const view = canvas(W, H), vg = view.getContext("2d"); vg.drawImage(c, 0, 0); vg.strokeStyle = "rgba(34,211,238,.9)"; vg.setLineDash([10, 8]); vg.lineWidth = 3;
      vg.beginPath(); vg.ellipse(W / 2, H * 0.1 + (H * S.head) / 2, (H * S.head) / 2.6, (H * S.head) / 2, 0, 0, 7); vg.stroke();
      showCanvas(ctx.view, view).classList.add("imgbox--small");
    };
    ctx.opts.append(opt("Size", segmented(Object.entries(SIZES).map(([k2, v]) => [k2, v.label]), key, (v) => { key = v; draw(); }).el),
      range("Zoom", 0.7, 1.4, 1, (v) => { zoom = v; draw(); }, 0.01), range("Left / right", -0.2, 0.2, 0, (v) => { dx = v; draw(); }, 0.005), range("Up / down", -0.2, 0.2, 0, (v) => { dy = v; draw(); }, 0.005),
      el("p", "hint", "Line up the face with the dotted oval. Requirements differ by country, so check the official rules before printing."));
    ctx.actions.append(
      button("Download photo", "btn btn--ghost", async () => download(await toBlob(out, "image/jpeg", 0.95), `passport_${key}.jpg`)),
      button("Download 4×6 print sheet", "btn btn--primary", async () => {
        const sheet = canvas(1800, 1200), g = sheet.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 1800, 1200);
        const cols = Math.floor(1740 / (out.width + 30)), rows = Math.floor(1140 / (out.height + 30));
        for (let r = 0; r < rows; r++) for (let c2 = 0; c2 < cols; c2++) { const x = 30 + c2 * (out.width + 30), y = 30 + r * (out.height + 30); g.drawImage(out, x, y); g.strokeStyle = "#ddd"; g.strokeRect(x - 0.5, y - 0.5, out.width + 1, out.height + 1); }
        download(await toBlob(sheet, "image/jpeg", 0.95), `passport_${key}_4x6_sheet.jpg`);
      }));
    draw();
  } }),

  "photo-to-sketch": (panel) => workspace(panel, { maxSide: 2600, onImage: (ctx) => {
    let lines = 8, colorize = false, out;
    const draw = () => {
      const s = ctx.src, W = s.width, H = s.height, g0 = s.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      const gray = canvas(W, H), gg = gray.getContext("2d", { willReadFrequently: true }), gi = gg.createImageData(W, H);
      for (let i = 0; i < g0.length; i += 4) { const v = 255 - (0.299 * g0[i] + 0.587 * g0[i + 1] + 0.114 * g0[i + 2]); gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = v; gi.data[i + 3] = 255; }
      gg.putImageData(gi, 0, 0);
      const bl = blurCanvas(gray, (lines * W) / 1000).getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      const c = canvas(W, H), g = c.getContext("2d"), o = g.createImageData(W, H);
      for (let i = 0; i < g0.length; i += 4) {
        const base = 255 - gi.data[i], v = Math.min(255, (base * 255) / Math.max(1, 255 - bl[i])), t = Math.pow(v / 255, 1.6) * 255;
        if (colorize) { o.data[i] = (g0[i] * 0.55 + 255 * 0.45) * (t / 255); o.data[i + 1] = (g0[i + 1] * 0.55 + 255 * 0.45) * (t / 255); o.data[i + 2] = (g0[i + 2] * 0.55 + 255 * 0.45) * (t / 255); }
        else o.data[i] = o.data[i + 1] = o.data[i + 2] = t;
        o.data[i + 3] = 255;
      }
      g.putImageData(o, 0, 0); out = c; showCanvas(ctx.view, c);
    };
    ctx.opts.append(range("Line softness", 2, 25, lines, (v) => { lines = v; draw(); }), opt("Style", segmented([[false, "Pencil"], [true, "Color pencil"]], false, (v) => { colorize = v; draw(); }).el));
    saveButtons(ctx, () => out, { name: `${baseName(ctx.file.name)}_sketch`, png: false }); draw();
  } }),

  vectorize: (panel) => workspace(panel, { title: "Drop a logo, icon or drawing", sub: "Simple graphics give the cleanest SVG", maxSide: 900, onImage: async (ctx) => {
    ctx.st.set("Loading the vectorizer…");
    if (!window.ImageTracer) await new Promise((r, j) => document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.js", onload: r, onerror: () => j(new Error("Couldn't load the vectorizer")) })));
    ctx.st.set("");
    let colors = 8, detail = "med", svg = "";
    const draw = async () => {
      ctx.st.set("Tracing…"); await new Promise((r) => setTimeout(r, 20));
      const d = { low: { ltres: 2, qtres: 2, pathomit: 16 }, med: { ltres: 1, qtres: 1, pathomit: 8 }, high: { ltres: 0.5, qtres: 0.5, pathomit: 2 } }[detail];
      const id = ctx.src.getContext("2d").getImageData(0, 0, ctx.src.width, ctx.src.height);
      svg = window.ImageTracer.imagedataToSVG(id, { ...d, numberofcolors: colors, colorquantcycles: 3, blurradius: 0, strokewidth: 0, linefilter: detail !== "high", roundcoords: 1, viewbox: true });
      const box = el("div", "imgbox imgbox--alpha svgbox"); box.innerHTML = svg; ctx.view.replaceChildren(box);
      ctx.st.set(`SVG ready · ${fmtBytes(svg.length)}`); setTimeout(() => ctx.st.set(""), 1500);
    };
    ctx.opts.append(opt("Colors", segmented([[2, "2"], [4, "4"], [8, "8"], [16, "16"], [32, "32"]], colors, (v) => { colors = v; draw(); }).el), opt("Detail", segmented([["low", "Smooth"], ["med", "Balanced"], ["high", "Detailed"]], detail, (v) => { detail = v; draw(); }).el));
    ctx.actions.append(button("Download SVG", "btn btn--primary", () => download(new Blob([svg], { type: "image/svg+xml" }), `${baseName(ctx.file.name)}.svg`)));
    await draw();
  } }),

  "blur-areas": (panel) => workspace(panel, { title: "Drop a photo", sub: "Hide faces, license plates, addresses", onImage: (ctx) => {
    const boxes = []; let mode = "blur", strength = 16, out, scale = 1;
    const view = canvas(...fit(ctx.src, 1100)); scale = ctx.src.width / view.width;
    const apply = (src, k) => {
      const c = canvas(src.width, src.height), g = c.getContext("2d"); g.drawImage(src, 0, 0);
      for (const b of boxes) {
        const x = b.x * c.width, y = b.y * c.height, w = b.w * c.width, h = b.h * c.height; if (w < 2 || h < 2) continue;
        const part = canvas(w, h); part.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h);
        g.save(); g.beginPath(); g.roundRect(x, y, w, h, Math.min(w, h) * 0.12); g.clip();
        if (b.mode === "pixel") { const n = Math.max(2, (strength * k) / 1.2), t = canvas(w / n, h / n); t.getContext("2d").drawImage(part, 0, 0, t.width, t.height); g.imageSmoothingEnabled = false; g.drawImage(t, x, y, w, h); }
        else if (b.mode === "black") { g.fillStyle = "#000"; g.fillRect(x, y, w, h); }
        else { const pad = strength * k * 2, big = canvas(w + pad * 2, h + pad * 2); big.getContext("2d").drawImage(src, x - pad, y - pad, big.width, big.height, 0, 0, big.width, big.height); g.drawImage(blurCanvas(big, strength * k), pad, pad, w, h, x, y, w, h); }
        g.restore();
      }
      return c;
    };
    const draw = () => { const c = apply(view, 1); const box = showCanvas(ctx.view, c); box.classList.add("drawable"); bind(box, c); };
    const bind = (box, c) => box.addEventListener("pointerdown", (e) => {
      const r = c.getBoundingClientRect(), x0 = (e.clientX - r.left) / r.width, y0 = (e.clientY - r.top) / r.height, b = { x: x0, y: y0, w: 0, h: 0, mode };
      const sel = el("div", "drawsel"); box.append(sel); box.setPointerCapture(e.pointerId);
      const mv = (ev) => { const x1 = (ev.clientX - r.left) / r.width, y1 = (ev.clientY - r.top) / r.height; Object.assign(b, { x: Math.max(0, Math.min(x0, x1)), y: Math.max(0, Math.min(y0, y1)), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }); Object.assign(sel.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }); };
      const up = () => { box.removeEventListener("pointermove", mv); box.removeEventListener("pointerup", up); if (b.w > 0.01 && b.h > 0.01) boxes.push(b); draw(); };
      box.addEventListener("pointermove", mv); box.addEventListener("pointerup", up);
    });
    ctx.opts.append(opt("Effect", segmented([["blur", "Blur"], ["pixel", "Pixelate"], ["black", "Black box"]], mode, (v) => (mode = v)).el), range("Strength", 4, 40, strength, (v) => { strength = v; draw(); }),
      opt("Edit", button("Undo last", "btn btn--ghost btn--sm", () => { boxes.pop(); draw(); })), el("p", "hint", "Drag over the photo to cover an area. Add as many as you need."));
    saveButtons(ctx, () => (out = apply(ctx.src, scale)), { name: `${baseName(ctx.file.name)}_private`, png: false }); draw();
  } }),

  "watermark-image": (panel) => batch(panel, {
    title: "Drop photos to watermark", cta: "Add watermark",
    options: (o, st) => {
      Object.assign(st, { text: "© Your Name", pos: "br", size: 5, opacity: 70, color: "#ffffff", tiled: false, logo: null });
      const t = input("text", st.text); t.oninput = () => (st.text = t.value);
      const col = input("color", st.color); col.oninput = () => (st.color = col.value);
      const logoBtn = button("Use a logo instead", "btn btn--ghost btn--sm", async () => { const f = await new Promise((r) => { const i = input("file", "", { accept: "image/*" }); i.onchange = () => r(i.files[0]); i.click(); }); if (f) { st.logo = await loadImage(f, 800); logoBtn.textContent = "Logo added ✓"; } });
      const tl = el("label", "check", '<input type="checkbox" /> Repeat across the photo'); tl.firstChild.onchange = (e) => (st.tiled = e.target.checked);
      o.append(opt("Text", t), opt("Position", segmented([["tl", "↖"], ["tr", "↗"], ["c", "•"], ["bl", "↙"], ["br", "↘"]], st.pos, (v) => (st.pos = v)).el), range("Size", 2, 14, st.size, (v) => (st.size = v)), range("Opacity", 10, 100, st.opacity, (v) => (st.opacity = v)), opt("Color", col), opt("Logo", logoBtn), tl);
    },
    process: async (file, st) => {
      const c = await loadImage(file), g = c.getContext("2d"), W = c.width, H = c.height, m = Math.min(W, H) * 0.035;
      g.globalAlpha = st.opacity / 100;
      let mark; // draw the mark once, then stamp it
      if (st.logo) { const w = (W * st.size * 2.6) / 100, h = (w * st.logo.height) / st.logo.width; mark = canvas(w, h); mark.getContext("2d").drawImage(st.logo, 0, 0, w, h); }
      else { const fs = (Math.min(W, H) * st.size) / 100; const mg = canvas(1, 1).getContext("2d"); mg.font = `600 ${fs}px Inter, system-ui, sans-serif`; const tw = mg.measureText(st.text).width; mark = canvas(tw + fs, fs * 1.5); const x = mark.getContext("2d"); x.font = `600 ${fs}px Inter, system-ui, sans-serif`; x.fillStyle = st.color; x.shadowColor = "rgba(0,0,0,.35)"; x.shadowBlur = fs / 8; x.textBaseline = "middle"; x.fillText(st.text, fs / 2, mark.height / 2); }
      if (st.tiled) { g.save(); g.translate(W / 2, H / 2); g.rotate(-Math.PI / 6); for (let y = -H; y < H; y += mark.height * 3) for (let x = -W; x < W; x += mark.width * 1.6) g.drawImage(mark, x, y); g.restore(); }
      else { const x = st.pos.includes("l") ? m : st.pos.includes("r") ? W - mark.width - m : (W - mark.width) / 2, y = st.pos.includes("t") ? m : st.pos.includes("b") ? H - mark.height - m : (H - mark.height) / 2; g.drawImage(mark, x, y); }
      const type = file.type === "image/png" ? "image/png" : "image/jpeg";
      return { blob: type === "image/jpeg" ? await encodeJpeg(c, 90) : await toBlob(c, type), name: `${baseName(file.name)}_watermarked.${type === "image/png" ? "png" : "jpg"}` };
    },
  }),

  "remove-metadata": (panel) => batch(panel, {
    title: "Drop photos to clean", cta: "Remove hidden info", sub: "Removes GPS location, camera details and dates. The picture itself isn't touched.",
    process: async (file) => {
      const buf = new Uint8Array(await file.arrayBuffer()), ext = extOf(file.name);
      if (file.type === "image/jpeg" || ext === "jpg" || ext === "jpeg") { const found = readExifSummary(buf); return { blob: stripJpeg(buf), name: `${baseName(file.name)}_clean.jpg`, note: found.size ? `removed: ${[...found].join(", ")}` : "nothing hidden found" }; }
      if (file.type === "image/png") { const r = stripPng(buf); return { blob: r.blob, name: `${baseName(file.name)}_clean.png`, note: r.found.size ? `removed: ${[...r.found].join(", ")}` : "nothing hidden found" }; }
      const c = await loadImage(file); return { blob: await toBlob(c, "image/jpeg", 0.95), name: `${baseName(file.name)}_clean.jpg`, note: "re-saved without metadata" };
    },
  }),

  "compress-to-size": (panel) => batch(panel, {
    title: "Drop photos to shrink", cta: "Compress", sub: "For forms that say \"maximum 100 KB\" and similar.",
    options: (o, st) => { st.kb = 100; const k = input("number", 100, { min: 10, max: 20000 }); k.style.width = "110px"; k.oninput = () => (st.kb = +k.value || 100); o.append(opt("Target size (KB)", k), opt("Quick picks", segmented([[50, "50 KB"], [100, "100 KB"], [200, "200 KB"], [500, "500 KB"], [1000, "1 MB"]], 100, (v) => { st.kb = v; k.value = v; }).el)); },
    process: async (file, st) => {
      const target = st.kb * 1024; let c = await loadImage(file), best = null;
      for (let round = 0; round < 8 && !best; round++) {
        let lo = 0.3, hi = 0.95, ok = null;
        for (let i = 0; i < 7; i++) { const q = (lo + hi) / 2, b = await toBlob(c, "image/jpeg", q); if (b.size <= target) { ok = b; lo = q; } else hi = q; }
        if (ok) best = ok; else { const s = canvas(c.width * 0.8, c.height * 0.8), g = s.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, s.width, s.height); c = s; }
      }
      if (!best) throw new Error("Couldn't get it that small");
      // the browser encoder found the size; MozJPEG gets better quality inside the same budget
      let q = 0.95, moz = null; for (let i = 0; i < 6; i++) { const b = await encodeJpeg(c, Math.round(q * 100)); if (b.size <= target) { moz = b; break; } q -= 0.1; }
      return { blob: moz || best, name: `${baseName(file.name)}_${st.kb}kb.jpg`, note: `${c.width}×${c.height}${moz ? ` · quality ${Math.round(q * 100)}` : ""}` };
    },
  }),
};

const fit = (c, max) => { const k = Math.min(1, max / Math.max(c.width, c.height)); return [Math.round(c.width * k), Math.round(c.height * k)]; };

/** Many files, same options, one result row each. */
function batch(panel, { title, sub = "JPG, PNG or WebP", cta, options, process }) {
  const st = {}, opts = el("div", "opts"), jobs = el("div", "jobs"), results = [];
  options?.(opts, st);
  const tail = el("div", "row-end"); tail.hidden = true; tail.append(button("Download all (.zip)", "btn btn--primary", () => downloadZip(results, "q-ft-images.zip")));
  panel.append(dropzone({ accept: "image/*", multiple: true, title, sub, onFiles: async (files) => {
    for (const f of files) {
      const row = jobRow(f.name); row.thumb(Object.assign(document.createElement("img"), { src: URL.createObjectURL(f), className: "job__thumb", alt: "" })); row.meta(`${fmtBytes(f.size)} · ${cta.toLowerCase()}…`); jobs.appendChild(row.el);
      try { const r = await process(f, st); results.push(r); row.progress(null); row.meta(`${fmtBytes(f.size)} → <b>${fmtBytes(r.blob.size)}</b> · <span class="ok">Done</span>${r.note ? ` · ${esc(r.note)}` : ""}`); row.actions(button("Download", "btn btn--primary btn--sm", () => download(r.blob, r.name))); }
      catch (e) { row.progress(null); row.meta(`<span class="bad">${esc(e.message)}</span>`); }
      tail.hidden = results.length < 2;
    }
  } }), opts, jobs, tail);
}

export function mount(panel, mode) {
  const M = MODES[mode]; if (!M) { panel.textContent = "Unknown tool"; return; }
  M(panel);
}
