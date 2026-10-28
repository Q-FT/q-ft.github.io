// AI Photo Enhancer: Real-ESRGAN (realesr-general-x4v3, BSD-3) running in the browser with ONNX Runtime Web.
// WebGPU when available, WebAssembly otherwise. The photo is processed in overlapping tiles so any size works.
import { CDN } from "./config.js";
import { $, esc, fmtBytes, baseName, dropzone, segmented, opt, jobRow, button, download, downloadZip, toast } from "./ui.js";
import { state as creditState, spend, openPaywall } from "./credits.js";

const MODEL_URL = "models/realesr-general-x4v3.onnx";
const PAD = 12;                       // tile overlap, hides seams
const MAX_OUT_PX = 16_000_000;        // stay under Safari's canvas limit (16.7 MP)

let engineP = null;
function engine(onStatus) {
  if (engineP) return engineP;
  engineP = (async () => {
    let gpu = false;
    try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch {}
    onStatus("Starting the AI engine…");
    const ort = await import(CDN.ortDir + (gpu ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
    ort.env.wasm.wasmPaths = CDN.ortDir;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const model = await fetchProgress(MODEL_URL, (p) => onStatus(`Downloading the AI model (5 MB, only the first time)… ${Math.round(p * 100)}%`));
    onStatus("Starting the AI engine…");
    for (const ep of gpu ? ["webgpu", "wasm"] : ["wasm"]) {
      try {
        const session = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: "all" });
        return { ort, session, backend: ep, tile: ep === "webgpu" ? 192 : 128 };
      } catch (e) { console.warn(`ORT ${ep} failed`, e); }
    }
    throw new Error("The AI engine couldn't start in this browser.");
  })();
  engineP.catch(() => { engineP = null; });
  return engineP;
}

async function fetchProgress(url, onP) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Model download failed (${r.status})`);
  const total = Number(r.headers.get("content-length")) || 4_866_395;
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onP(Math.min(1, got / total)); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });

/** Upscale an ImageBitmap by `scale` (2 or 4). Returns a canvas. */
async function upscale(eng, bmp, scale, onProgress) {
  const { ort, session, tile: T } = eng;
  const W = bmp.width, H = bmp.height;
  const src = canvas(W, H).getContext("2d", { willReadFrequently: true });
  src.drawImage(bmp, 0, 0);
  const rgba = src.getImageData(0, 0, W, H).data;
  let hasAlpha = false; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { hasAlpha = true; break; }

  const out = canvas(W * scale, H * scale); const octx = out.getContext("2d");
  const tilesX = Math.ceil(W / T), tilesY = Math.ceil(H / T), total = tilesX * tilesY; let done = 0;
  for (let ty = 0; ty < H; ty += T) {
    for (let tx = 0; tx < W; tx += T) {
      const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD), x1 = Math.min(W, tx + T + PAD), y1 = Math.min(H, ty + T + PAD);
      const w = x1 - x0, h = y1 - y0, n = w * h, inp = new Float32Array(3 * n);
      for (let y = 0; y < h; y++) {
        let si = ((y0 + y) * W + x0) * 4, di = y * w;
        for (let x = 0; x < w; x++, si += 4, di++) { inp[di] = rgba[si] / 255; inp[n + di] = rgba[si + 1] / 255; inp[2 * n + di] = rgba[si + 2] / 255; }
      }
      const res = await session.run({ input: new ort.Tensor("float32", inp, [1, 3, h, w]) });
      const d = res.output.data, ow = w * 4, on = ow * h * 4;
      // keep only the tile's own area (drop the overlap), at 4x
      const cx = (tx - x0) * 4, cy = (ty - y0) * 4, cw = (Math.min(tx + T, W) - tx) * 4, ch = (Math.min(ty + T, H) - ty) * 4;
      let img;
      if (scale === 4) {
        img = new ImageData(cw, ch); const p = img.data;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const si = (cy + y) * ow + cx + x, di = (y * cw + x) * 4;
          p[di] = d[si] * 255; p[di + 1] = d[on + si] * 255; p[di + 2] = d[2 * on + si] * 255; p[di + 3] = 255;
        }
      } else {
        // 2x: average each 2x2 block of the 4x result (sharper than running a 2x model, and seamless)
        const hw = cw / 2, hh = ch / 2; img = new ImageData(hw, hh); const p = img.data;
        for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
          const a = (cy + 2 * y) * ow + cx + 2 * x, b = a + ow, di = (y * hw + x) * 4;
          for (let c = 0; c < 3; c++) { const o = c * on; p[di + c] = (d[o + a] + d[o + a + 1] + d[o + b] + d[o + b + 1]) * 63.75; }
          p[di + 3] = 255;
        }
      }
      octx.putImageData(img, tx * scale, ty * scale);
      res.output.dispose?.();
      onProgress(++done / total);
      await new Promise((r) => setTimeout(r)); // let the page breathe between tiles
    }
  }
  if (hasAlpha) { // transparency: smooth-upscale the original alpha channel
    const a = canvas(out.width, out.height).getContext("2d"); a.imageSmoothingQuality = "high"; a.drawImage(bmp, 0, 0, out.width, out.height);
    const ad = a.getImageData(0, 0, out.width, out.height).data, od = octx.getImageData(0, 0, out.width, out.height);
    for (let i = 3; i < ad.length; i += 4) od.data[i] = ad[i];
    octx.putImageData(od, 0, 0);
  }
  return { out, hasAlpha };
}

/** Make sure the result fits in a browser canvas: shrink the input first if needed. */
async function fitInput(file, scale) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxIn = MAX_OUT_PX / (scale * scale);
  if (bmp.width * bmp.height <= maxIn) return { bmp, resized: false };
  const k = Math.sqrt(maxIn / (bmp.width * bmp.height));
  const w = Math.floor(bmp.width * k), h = Math.floor(bmp.height * k);
  const c = canvas(w, h).getContext("2d"); c.imageSmoothingQuality = "high"; c.drawImage(bmp, 0, 0, w, h); bmp.close();
  return { bmp: await createImageBitmap(c.canvas), resized: true };
}

const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Encoding failed"))), type, q));

export function mount(panel) {
  let scale = 4, format = "auto";
  const results = [];
  const queue = []; let running = false; let alive = true;

  const status = document.createElement("div"); status.className = "status"; status.hidden = true;
  const jobs = document.createElement("div"); jobs.className = "jobs";
  const compare = document.createElement("div");
  const tail = document.createElement("div"); tail.className = "row-end"; tail.hidden = true;
  const credits = document.createElement("p"); credits.className = "hint";
  const showCredits = () => { const s = creditState(); credits.innerHTML = s.paid > 0 ? `<b>${s.total}</b> enhancements left.` : `<b>${s.freeLeft}</b> of 10 free enhancements left on this device. Each photo uses one.`; };
  showCredits();

  const opts = document.createElement("div"); opts.className = "opts";
  opts.append(
    opt("Enlarge", segmented([[2, "2×"], [4, "4×"]], scale, (v) => (scale = v))),
    opt("Save as", segmented([["auto", "Auto"], ["image/png", "PNG"], ["image/jpeg", "JPG"]], format, (v) => (format = v))),
  );
  const dz = dropzone({ accept: "image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif,image/heic", multiple: true, title: "Drop photos here or click to choose", sub: "JPG, PNG or WebP · up to 16 megapixels out", onFiles: add });
  panel.append(dz, opts, credits, status, jobs, compare, tail);

  const setStatus = (msg) => { status.hidden = !msg; status.innerHTML = msg ? `<span class="spin"></span>${esc(msg)}` : ""; };

  function add(files) {
    for (const f of files) {
      if (!f.type.startsWith("image/")) { toast(`${f.name} isn't an image`); continue; }
      const row = jobRow(f.name); const url = URL.createObjectURL(f);
      row.thumb(Object.assign(document.createElement("img"), { src: url, className: "job__thumb", alt: "" }));
      row.meta(`${fmtBytes(f.size)} · waiting`); row.progress(0);
      jobs.appendChild(row.el);
      queue.push({ file: f, row, url, scale, format });
    }
    pump();
  }

  async function pump() {
    if (running) return; running = true;
    while (queue.length && alive) {
      const job = queue[0];
      if (creditState().total <= 0) { job.row.meta(`<span class="bad">No enhancements left.</span>`); openPaywall(); break; }
      queue.shift();
      await run(job);
      showCredits();
    }
    running = false; setStatus("");
  }

  async function run({ file, row, url, scale, format }) {
    try {
      row.meta("Preparing…");
      const eng = await engine(setStatus);
      setStatus(eng.backend === "webgpu" ? "Enhancing on your graphics card (WebGPU)…" : "Enhancing on your processor. Tip: Chrome or Edge can use your graphics card and is much faster.");
      const { bmp, resized } = await fitInput(file, scale);
      const t0 = performance.now();
      row.meta(`${bmp.width}×${bmp.height} → ${bmp.width * scale}×${bmp.height * scale} · enhancing…`);
      const { out, hasAlpha } = await upscale(eng, bmp, scale, (p) => row.progress(p));
      bmp.close();
      const type = format === "auto" ? (hasAlpha || file.type === "image/png" ? "image/png" : "image/jpeg") : format;
      const blob = await toBlob(out, type, 0.95);
      spend();
      const name = `${baseName(file.name)}_enhanced_${scale}x.${type === "image/png" ? "png" : "jpg"}`;
      const outUrl = URL.createObjectURL(blob);
      results.push({ name, blob });
      row.progress(null);
      row.meta(`<span class="ok">Done</span> · ${out.width}×${out.height} · ${fmtBytes(blob.size)} · ${((performance.now() - t0) / 1000).toFixed(1)} s${resized ? " · large photo, resized first to fit" : ""}`);
      row.actions(button("Compare", "btn btn--ghost btn--sm", () => showCompare(url, outUrl)), button("Download", "btn btn--primary btn--sm", () => download(blob, name)));
      showCompare(url, outUrl);
      tail.hidden = results.length < 2;
    } catch (e) {
      console.error(e);
      row.progress(null); row.meta(`<span class="bad">${esc(e.message || "Something went wrong")}</span>`);
    }
  }

  function showCompare(before, after) {
    compare.innerHTML = `<div class="compare"><img src="${after}" alt="Enhanced" /><div class="compare__before"><img src="${before}" alt="Original" /></div><div class="compare__line"></div><span class="compare__lab compare__lab--l">Before</span><span class="compare__lab compare__lab--r">After</span></div><p class="hint">Drag across the photo to compare. Zoom in to see the detail.</p>`;
    const box = $(".compare", compare), b = $(".compare__before", compare), line = $(".compare__line", compare);
    const set = (x) => { const r = box.getBoundingClientRect(); const p = Math.min(1, Math.max(0, (x - r.left) / r.width)); b.style.clipPath = `inset(0 ${100 - p * 100}% 0 0)`; line.style.left = `${p * 100}%`; };
    set(box.getBoundingClientRect().left + box.getBoundingClientRect().width / 2);
    box.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "mouse") set(e.clientX); });
    box.addEventListener("pointerdown", (e) => set(e.clientX));
  }

  tail.append(button("Download all (.zip)", "btn btn--primary", () => downloadZip(results, "q-ft-enhanced.zip")));
  return { unmount() { alive = false; } };
}
