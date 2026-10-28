// Compress & convert images. Auto keeps photos as JPEG (MozJPEG) and graphics/transparent images as PNG
// (UPNG: lossless or 256-color). Re-encoding drops EXIF (location) while respecting the photo's rotation.
// A result is never bigger than the original: if it would be, the original is kept.
import { esc, fmtBytes, baseName, extOf, dropzone, segmented, opt, jobRow, button, download, downloadZip, compareView } from "./ui.js";
import { encodeJpeg, encodePng, analyze } from "./codecs.js";

const EXT = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };
const canvasBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("This browser can't save that format"))), type, q));

/** quality 0-100 -> palette size for PNG (100 = lossless) */
const pngColors = (q) => (q >= 95 ? 0 : q >= 70 ? 256 : q >= 50 ? 128 : 64);

export async function compressImage(file, { format = "auto", quality = 82, maxSide = 0 } = {}) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, w, h); bmp.close();
  const info = analyze(c);
  let type = format;
  if (format === "auto") type = info.alpha || (!info.photo && file.type !== "image/jpeg") ? "image/png" : "image/jpeg";
  if (format === "same") type = EXT[file.type] ? file.type : "image/png";
  let blob;
  if (type === "image/jpeg") {
    if (info.alpha) { const flat = Object.assign(document.createElement("canvas"), { width: w, height: h }), fg = flat.getContext("2d"); fg.fillStyle = "#fff"; fg.fillRect(0, 0, w, h); fg.drawImage(c, 0, 0); blob = await encodeJpeg(flat, quality); }
    else blob = await encodeJpeg(c, quality);
  } else if (type === "image/png") {
    blob = await encodePng(c, pngColors(quality));
  } else {
    blob = await canvasBlob(c, "image/webp", quality / 100);
    if (blob.type !== "image/webp") throw new Error("This browser can't save WebP. Pick Auto or JPG.");
  }
  const kept = blob.size >= file.size && k === 1 && (format === "auto" || format === "same" || type === file.type);
  return { blob: kept ? file : blob, type: kept ? file.type : type, w, h, kept, info, canvas: c };
}

export function mount(panel) {
  let format = "auto", quality = 82, maxSide = 0;
  const results = [];
  const q = Object.assign(document.createElement("input"), { type: "range", min: 30, max: 100, value: quality });
  const qv = document.createElement("span");
  const qText = () => (qv.textContent = `${quality}%${quality >= 95 ? " · near lossless" : quality >= 78 ? " · visually identical" : quality >= 60 ? " · good" : " · smallest"}`);
  q.addEventListener("input", () => { quality = Number(q.value); qText(); });
  qText();
  const qWrap = document.createElement("span"); qWrap.style.cssText = "display:flex;gap:10px;align-items:center"; qWrap.append(q, qv);
  const size = document.createElement("select");
  size.innerHTML = [[0, "Keep original"], [3840, "4K (3840 px)"], [2560, "2560 px"], [1920, "Full HD (1920 px)"], [1280, "1280 px"], [800, "800 px"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  size.addEventListener("change", () => (maxSide = Number(size.value)));

  const opts = document.createElement("div"); opts.className = "opts";
  opts.append(opt("Format", segmented([["auto", "Auto (best)"], ["image/jpeg", "JPG"], ["image/webp", "WebP"], ["image/png", "PNG"], ["same", "Keep format"]], format, (v) => (format = v)).el), opt("Quality", qWrap), opt("Longest side", size));
  const hint = document.createElement("p"); hint.className = "hint";
  hint.innerHTML = "<b>Auto</b> keeps photos as high quality JPEG and keeps transparency and screenshots as PNG. 82% looks identical to the original. Hidden info like GPS location is removed. If a file can't get smaller, you keep the original.";
  const jobs = document.createElement("div"); jobs.className = "jobs";
  const cmp = document.createElement("div");
  const tail = document.createElement("div"); tail.className = "row-end"; tail.hidden = true;
  tail.append(button("Download all (.zip)", "btn btn--primary", () => downloadZip(results, "q-ft-images.zip")));
  panel.append(dropzone({ accept: "image/*", multiple: true, title: "Drop images here or click to choose", sub: "JPG, PNG, WebP, GIF, BMP, AVIF (HEIC on Safari)", onFiles: add }), opts, hint, jobs, cmp, tail);

  async function add(files) {
    for (const f of files) {
      const row = jobRow(f.name); const url = URL.createObjectURL(f);
      row.thumb(Object.assign(document.createElement("img"), { src: url, className: "job__thumb", alt: "" }));
      row.meta(`${fmtBytes(f.size)} · compressing…`); row.progress(null);
      jobs.appendChild(row.el);
      try {
        const r = await compressImage(f, { format, quality, maxSide });
        const name = `${baseName(f.name)}${r.kept ? "" : "_q-ft"}.${r.kept ? extOf(f.name) : EXT[r.type]}`;
        results.push({ name, blob: r.blob });
        const saved = 1 - r.blob.size / f.size;
        row.meta(`${r.w}×${r.h} · ${EXT[r.type]?.toUpperCase() || ""} · ${fmtBytes(f.size)} → <b>${fmtBytes(r.blob.size)}</b> ${r.kept ? "· already optimal, original kept" : saved > 0 ? `· <span class="ok">${Math.round(saved * 100)}% smaller</span>` : ""}`);
        const outUrl = URL.createObjectURL(r.blob);
        row.actions(button("Compare", "btn btn--ghost btn--sm", () => { cmp.replaceChildren(); compareView(cmp, url, outUrl, ["Original", `Compressed · ${fmtBytes(r.blob.size)}`]); cmp.scrollIntoView({ behavior: "smooth", block: "nearest" }); }), button("Download", "btn btn--primary btn--sm", () => download(r.blob, name)));
      } catch (e) { row.meta(`<span class="bad">${esc(e.message || "Couldn't read this image")}</span>`); }
      tail.hidden = results.length < 2;
    }
  }
}
