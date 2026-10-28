// Compress & convert images: JPG / WebP / PNG, quality and max size, in bulk. Canvas re-encode drops EXIF
// (location data) while respecting the photo's rotation.
import { esc, fmtBytes, baseName, extOf, dropzone, segmented, opt, jobRow, button, download, downloadZip } from "./ui.js";

const TYPES = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };
const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("This browser can't save that format"))), type, q));

export function mount(panel) {
  let format = "image/jpeg", quality = 80, maxSide = 0;
  const results = [];
  const q = Object.assign(document.createElement("input"), { type: "range", min: 30, max: 100, value: quality });
  const qv = document.createElement("span"); qv.textContent = `${quality}%`;
  q.addEventListener("input", () => { quality = Number(q.value); qv.textContent = `${quality}%`; });
  const qWrap = document.createElement("span"); qWrap.style.cssText = "display:flex;gap:10px;align-items:center"; qWrap.append(q, qv);
  const size = document.createElement("select");
  size.innerHTML = [[0, "Keep original"], [3840, "4K (3840 px)"], [2560, "2560 px"], [1920, "Full HD (1920 px)"], [1280, "1280 px"], [800, "800 px"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  size.addEventListener("change", () => (maxSide = Number(size.value)));

  const opts = document.createElement("div"); opts.className = "opts";
  const fmt = segmented([["image/jpeg", "JPG"], ["image/webp", "WebP"], ["image/png", "PNG"], ["same", "Same"]], format, (v) => { format = v; qLabel.hidden = v === "image/png"; });
  const qLabel = opt("Quality", qWrap);
  opts.append(opt("Convert to", fmt), qLabel, opt("Longest side", size));
  const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = "80% is visually identical to the original for most photos. WebP gives the smallest files. Location data (EXIF) is removed.";
  const jobs = document.createElement("div"); jobs.className = "jobs";
  const tail = document.createElement("div"); tail.className = "row-end"; tail.hidden = true;
  tail.append(button("Download all (.zip)", "btn btn--primary", () => downloadZip(results, "q-ft-images.zip")));
  panel.append(dropzone({ accept: "image/*", multiple: true, title: "Drop images here or click to choose", sub: "JPG, PNG, WebP, GIF, BMP, AVIF (HEIC on Safari)", onFiles: add }), opts, hint, jobs, tail);

  async function add(files) {
    for (const f of files) {
      const row = jobRow(f.name); const url = URL.createObjectURL(f);
      row.thumb(Object.assign(document.createElement("img"), { src: url, className: "job__thumb", alt: "" }));
      jobs.appendChild(row.el);
      try {
        const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
        const k = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
        const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
        const type = format === "same" ? (TYPES[f.type] ? f.type : "image/png") : format;
        const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d");
        if (type === "image/jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); } // JPG has no transparency
        g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, w, h); bmp.close();
        let blob = await toBlob(c, type, quality / 100);
        if (type === "image/webp" && blob.type !== "image/webp") throw new Error("This browser can't save WebP, pick JPG");
        let kept = false;
        if (blob.size >= f.size && type === f.type && k === 1) { blob = f; kept = true; } // never make it bigger
        const name = `${baseName(f.name)}${kept ? "" : "_q-ft"}.${kept ? extOf(f.name) : TYPES[type]}`;
        results.push({ name, blob });
        const saved = 1 - blob.size / f.size;
        row.meta(`${w}×${h} · ${fmtBytes(f.size)} → <b>${fmtBytes(blob.size)}</b> ${kept ? "· already optimal" : saved > 0 ? `· <span class="ok">${Math.round(saved * 100)}% smaller</span>` : ""}`);
        row.progress(null);
        row.actions(button("Download", "btn btn--primary btn--sm", () => download(blob, name)));
      } catch (e) { row.progress(null); row.meta(`<span class="bad">${esc(e.message || "Couldn't read this image")}</span>`); }
      tail.hidden = results.length < 2;
    }
  }
}
