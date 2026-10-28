// Trim audio & video with ffmpeg.wasm (runs in a Web Worker, in the browser).
// Fast mode copies the streams (zero quality loss); precise mode re-encodes on the exact frame.
import { CDN } from "./config.js";
import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { toBlobURL } from "../vendor/ffmpeg-util/index.js";
import { $, esc, fmtBytes, fmtTime, parseTime, baseName, extOf, dropzone, segmented, opt, button, download, toast } from "./ui.js";

let ffP = null; // shared with mediatools.js
export function engine(onStatus) {
  if (ffP) return ffP;
  ffP = (async () => {
    const ff = new FFmpeg();
    onStatus("Loading the media engine (about 30 MB, only the first time)…");
    const coreURL = await toBlobURL(`${CDN.ffmpegCore}ffmpeg-core.js`, "text/javascript");
    const wasmURL = await blobUrlWithProgress(`${CDN.ffmpegCore}ffmpeg-core.wasm`, "application/wasm", (p) =>
      onStatus(`Loading the media engine (about 30 MB, only the first time)… ${Math.round(p * 100)}%`));
    await ff.load({ coreURL, wasmURL });
    return ff;
  })();
  ffP.catch(() => { ffP = null; });
  return ffP;
}

// The CDN may send the file compressed, so Content-Length can be smaller than what we receive:
// treat it as an estimate (the helper in @ffmpeg/util rejects that case).
async function blobUrlWithProgress(url, type, onP) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const est = Math.max(Number(r.headers.get("content-length")) || 0, 31_000_000);
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onP(Math.min(0.99, got / est)); }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

/** Run ffmpeg, reporting progress from its "time=" log lines. Returns the output file bytes. */
export async function ffrun(ff, args, outName, duration, onProgress) {
  const logs = [];
  const onLog = ({ message }) => {
    logs.push(message); if (logs.length > 60) logs.shift();
    const m = message.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m && duration > 0) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration));
  };
  ff.on("log", onLog);
  try {
    const code = await ff.exec(args);
    if (code !== 0) { console.warn(logs.join("\n")); throw new Error("ffmpeg failed"); }
    return await ff.readFile(outName);
  } finally { ff.off("log", onLog); }
}

const AUDIO_ENC = { mp3: ["-c:a", "libmp3lame", "-q:a", "0"], wav: ["-c:a", "pcm_s16le"], m4a: ["-c:a", "aac", "-b:a", "256k"], aac: ["-c:a", "aac", "-b:a", "256k"], flac: ["-c:a", "flac"], ogg: ["-c:a", "libvorbis", "-q:a", "7"], opus: ["-c:a", "libopus", "-b:a", "192k"] };
const MIME = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", gif: "image/gif", m4v: "video/mp4" };

export function mount(panel, kind) {
  const isVideo = kind === "video";
  let file = null, url = null, dur = 0, start = 0, end = 0, busy = false, alive = true;
  let mode = "fast", sound = "keep", out = "same", fadeIn = false, fadeOut = false;

  const dz = dropzone({
    accept: isVideo ? "video/*,.mkv,.mov" : "audio/*,.m4a,.flac,.opus,.ogg",
    title: `Drop ${isVideo ? "a video" : "an audio file"} here or click to choose`,
    sub: isVideo ? "MP4, MOV, WebM, MKV · stays on your device" : "MP3, WAV, M4A, FLAC, OGG · stays on your device",
    onFiles: (f) => load(f[0]),
  });
  const editor = document.createElement("div"); editor.hidden = true;
  panel.append(dz, editor);

  editor.innerHTML = `
    <${isVideo ? "video playsinline" : "audio"} class="player" controls preload="metadata"></${isVideo ? "video" : "audio"}>
    <div class="trim" aria-label="Selection"><canvas></canvas><div class="trim__shade" data-l></div><div class="trim__shade" data-r></div><div class="trim__sel"></div><div class="trim__ph"></div><div class="trim__h" data-h="s" tabindex="0" aria-label="Start"></div><div class="trim__h" data-h="e" tabindex="0" aria-label="End"></div></div>
    <div class="times">
      <label class="opt">Start<input type="text" data-t="s" inputmode="decimal" /></label>
      <label class="opt">End<input type="text" data-t="e" inputmode="decimal" /></label>
      <span class="opt">Length<b data-len style="color:var(--text);font-size:1rem;padding:8px 0"></b></span>
      <span style="display:flex;gap:8px;flex-wrap:wrap"></span>
    </div>
    <div class="opts" data-opts></div>
    <p class="hint" data-hint></p>
    <div class="status" data-status hidden></div>
    <div class="row-end" data-actions></div>
    <div data-result></div>`;
  const player = editor.querySelector(".player"), trim = $(".trim", editor), cv = $("canvas", trim);
  const sel = $(".trim__sel", trim), shL = $("[data-l]", trim), shR = $("[data-r]", trim), ph = $(".trim__ph", trim);
  const hS = $('[data-h="s"]', trim), hE = $('[data-h="e"]', trim), inS = $('[data-t="s"]', editor), inE = $('[data-t="e"]', editor), len = $("[data-len]", editor);
  const status = $("[data-status]", editor), result = $("[data-result]", editor), hint = $("[data-hint]", editor);
  const setStatus = (m) => { status.hidden = !m; status.innerHTML = m ? `<span class="spin"></span>${esc(m)}` : ""; };

  // quick buttons
  $(".times > span:last-child", editor).append(
    button("Set start here", "btn btn--ghost btn--sm", () => setRange(player.currentTime, end)),
    button("Set end here", "btn btn--ghost btn--sm", () => setRange(start, player.currentTime)),
    button("▶ Play selection", "btn btn--ghost btn--sm", () => { player.currentTime = start; player.play(); }),
  );
  player.addEventListener("timeupdate", () => { if (!player.paused && player.currentTime >= end) player.pause(); drawPh(); });

  // options
  const opts = $("[data-opts]", editor);
  if (isVideo) {
    opts.append(
      opt("Cut", segmented([["fast", "Fast · no quality loss"], ["precise", "Precise · exact frame"]], mode, (v) => { mode = v; explain(); })),
      opt("Sound", segmented([["keep", "Keep"], ["mute", "Remove"]], sound, (v) => (sound = v))),
      opt("Save as", segmented([["same", "Video"], ["mp3", "Audio only (MP3)"], ["gif", "GIF"]], out, (v) => { out = v; explain(); })),
    );
  } else {
    const fi = Object.assign(document.createElement("label"), { className: "check", innerHTML: '<input type="checkbox" /> Fade in' });
    const fo = Object.assign(document.createElement("label"), { className: "check", innerHTML: '<input type="checkbox" /> Fade out' });
    fi.firstChild.addEventListener("change", (e) => { fadeIn = e.target.checked; explain(); });
    fo.firstChild.addEventListener("change", (e) => { fadeOut = e.target.checked; explain(); });
    const fades = document.createElement("span"); fades.style.cssText = "display:flex;gap:16px"; fades.append(fi, fo);
    opts.append(opt("Save as", segmented([["same", "Same format"], ["mp3", "MP3"], ["wav", "WAV"]], out, (v) => { out = v; explain(); })), opt("Effects", fades));
  }
  function explain() {
    if (isVideo) hint.textContent = out === "gif" ? "GIF: 12 frames per second, up to 480 px wide. Best for short clips."
      : out === "mp3" ? "Saves only the sound of the selection as a high quality MP3."
      : mode === "fast" ? "Fast mode copies the video as is: zero quality loss and very quick. The cut lands on the nearest keyframe, so it can start a fraction of a second early."
      : "Precise mode cuts on the exact frame and re-encodes at high quality (saved as MP4). It takes longer.";
    else hint.textContent = out === "same" && !fadeIn && !fadeOut ? "Same format copies the audio as is: zero quality loss." : "The selection is re-encoded at high quality.";
  }
  explain();
  const goBtn = button(isVideo ? "Trim video" : "Trim audio", "btn btn--primary btn--lg", go); goBtn.dataset.go = "";
  $("[data-actions]", editor).append(
    button("Choose another file", "btn btn--ghost", () => { editor.hidden = true; dz.hidden = false; result.replaceChildren(); player.pause(); }),
    goBtn,
  );

  async function load(f) {
    if (!f) return;
    if (f.size > 1.5e9) { toast("That file is over 1.5 GB, too big to edit in a browser."); return; }
    if (f.size > 6e8) toast("Big file: this may be slow and use a lot of memory.", 5000);
    file = f; if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(f);
    player.src = url; result.replaceChildren();
    await new Promise((res, rej) => { player.onloadedmetadata = res; player.onerror = () => rej(new Error("unsupported")); }).catch(() => null);
    dur = isFinite(player.duration) ? player.duration : 0;
    if (!dur) { toast("This browser can't preview that file, but you can still trim it by typing times."); dur = 0; }
    dz.hidden = true; editor.hidden = false;
    setRange(0, dur);
    requestAnimationFrame(() => (isVideo ? thumbs() : wave()));
  }

  function setRange(s, e) {
    s = Math.max(0, Math.min(s, dur || s)); e = Math.max(s + 0.05, Math.min(e, dur || e));
    start = s; end = e;
    const P = (t) => (dur ? (t / dur) * 100 : 0);
    hS.style.left = `${P(s)}%`; hE.style.left = `${P(e)}%`;
    sel.style.left = `${P(s)}%`; sel.style.width = `${P(e) - P(s)}%`;
    shL.style.left = "0"; shL.style.width = `${P(s)}%`; shR.style.left = `${P(e)}%`; shR.style.right = "0";
    inS.value = fmtTime(s); inE.value = fmtTime(e); len.textContent = fmtTime(e - s);
  }
  const drawPh = () => { ph.style.left = `${dur ? (player.currentTime / dur) * 100 : 0}%`; };
  for (const [inp, which] of [[inS, "s"], [inE, "e"]]) inp.addEventListener("change", () => {
    const t = parseTime(inp.value); if (isNaN(t)) { setRange(start, end); return; }
    which === "s" ? setRange(t, end) : setRange(start, t);
  });

  // drag handles / click to seek
  let drag = null;
  trim.addEventListener("pointerdown", (e) => {
    const h = e.target.closest("[data-h]"); const t = timeAt(e.clientX);
    if (h) { drag = h.dataset.h; trim.setPointerCapture(e.pointerId); }
    else { player.currentTime = t; drawPh(); }
  });
  trim.addEventListener("pointermove", (e) => { if (!drag) return; const t = timeAt(e.clientX); drag === "s" ? setRange(Math.min(t, end - 0.05), end) : setRange(start, Math.max(t, start + 0.05)); player.currentTime = drag === "s" ? start : end; });
  trim.addEventListener("pointerup", () => (drag = null));
  for (const [h, w] of [[hS, "s"], [hE, "e"]]) h.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 1 : 0.1, d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0; if (!d) return;
    e.preventDefault(); w === "s" ? setRange(start + d, end) : setRange(start, end + d);
  });
  const timeAt = (x) => { const r = trim.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur; };

  async function wave() {
    const W = (cv.width = trim.clientWidth * devicePixelRatio), H = (cv.height = trim.clientHeight * devicePixelRatio), g = cv.getContext("2d");
    if (file.size > 150e6) return;
    try {
      const ac = new OfflineAudioContext(1, 1, 44100);
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      const ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / W));
      const grad = g.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, "#7c3aed"); grad.addColorStop(1, "#06b6d4"); g.fillStyle = grad;
      for (let x = 0; x < W; x += 2) {
        let peak = 0; const from = x * step; for (let i = from; i < from + step && i < ch.length; i += 8) peak = Math.max(peak, Math.abs(ch[i]));
        const bh = Math.max(2, peak * H * 0.9); g.fillRect(x, (H - bh) / 2, 1.4, bh);
      }
    } catch (e) { console.warn("waveform", e); }
  }

  async function thumbs() {
    const W = (cv.width = trim.clientWidth * devicePixelRatio), H = (cv.height = trim.clientHeight * devicePixelRatio), g = cv.getContext("2d");
    const v = Object.assign(document.createElement("video"), { muted: true, preload: "auto", src: url, playsInline: true });
    try {
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; });
      const tw = Math.max(40, H * (v.videoWidth / v.videoHeight || 16 / 9)), n = Math.ceil(W / tw);
      for (let i = 0; i < n && alive && v.src; i++) {
        v.currentTime = Math.min(dur - 0.05, ((i + 0.5) / n) * dur);
        await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); });
        g.drawImage(v, i * tw, 0, tw, H);
      }
    } catch (e) { console.warn("thumbnails", e); }
    v.removeAttribute("src"); v.load();
  }

  async function go() {
    if (busy || !file) return; busy = true;
    const btn = $("[data-go]", editor); btn.disabled = true; result.replaceChildren();
    const ext = extOf(file.name) || (isVideo ? "mp4" : "mp3"), inName = `in.${ext}`, length = end - start;
    try {
      const ff = await engine(setStatus);
      setStatus("Reading the file…");
      await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
      const plan = buildPlan(ext, length);
      let bytes, outExt = plan.ext;
      try {
        setStatus(plan.label);
        bytes = await ffrun(ff, plan.args, `out.${plan.ext}`, length, (p) => setStatus(`${plan.label} ${Math.round(p * 100)}%`));
      } catch (e) {
        if (!plan.fallback) throw e;
        setStatus("This format needs re-encoding, switching to precise mode…");
        bytes = await ffrun(ff, plan.fallback.args, `out.${plan.fallback.ext}`, length, (p) => setStatus(`Re-encoding… ${Math.round(p * 100)}%`));
        outExt = plan.fallback.ext;
      }
      ff.deleteFile(inName).catch(() => {}); ff.deleteFile(`out.${outExt}`).catch(() => {});
      const blob = new Blob([bytes], { type: MIME[outExt] || "application/octet-stream" });
      const name = `${baseName(file.name)}_trimmed.${outExt}`;
      const isImg = outExt === "gif", isVid = !isImg && MIME[outExt]?.startsWith("video");
      result.innerHTML = `<div class="job" style="grid-template-columns:1fr auto;margin-top:16px"><div><div class="job__name">${esc(name)}</div><div class="job__meta"><span class="ok">Done</span> · ${fmtTime(length)} · ${fmtBytes(blob.size)}</div></div><div class="job__act"></div></div>`;
      const preview = isImg ? Object.assign(document.createElement("img"), { src: URL.createObjectURL(blob), style: "margin-top:12px;border-radius:12px;max-height:50vh" })
        : Object.assign(document.createElement(isVid ? "video" : "audio"), { src: URL.createObjectURL(blob), controls: true, className: "player", style: "margin-top:12px" });
      $(".job__act", result).append(button("Download", "btn btn--primary", () => download(blob, name)));
      result.append(preview);
      download(blob, name);
    } catch (e) {
      console.error(e); toast("Sorry, that didn't work. Try Precise mode or another format.", 5000);
    } finally { setStatus(""); btn.disabled = false; busy = false; }
  }

  function buildPlan(ext, length) {
    const ss = ["-ss", start.toFixed(3), "-i", `in.${ext}`, "-t", length.toFixed(3)];
    if (isVideo) {
      const precise = { ext: "mp4", args: [...ss, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...(sound === "mute" ? ["-an"] : ["-c:a", "aac", "-b:a", "192k"]), "-movflags", "+faststart", "out.mp4"] };
      if (out === "mp3") return { ext: "mp3", label: "Extracting the audio…", args: [...ss, "-vn", "-c:a", "libmp3lame", "-q:a", "0", "out.mp3"] };
      if (out === "gif") return { ext: "gif", label: "Making the GIF…", args: [...ss, "-vf", "fps=12,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", "out.gif"] };
      if (mode === "precise") return { ...precise, label: "Cutting on the exact frame…" };
      return { ext, label: "Cutting…", args: [...ss, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", ...(sound === "mute" ? ["-an"] : []), "-avoid_negative_ts", "make_zero", `out.${ext}`], fallback: precise };
    }
    const fades = [fadeIn && `afade=t=in:st=0:d=${Math.min(1.5, length / 3).toFixed(2)}`, fadeOut && `afade=t=out:st=${Math.max(0, length - Math.min(1.5, length / 3)).toFixed(2)}:d=${Math.min(1.5, length / 3).toFixed(2)}`].filter(Boolean);
    const target = out === "same" ? ext : out;
    const reencode = (e) => ({ ext: e, args: [...ss, "-map", "0:a:0", ...(fades.length ? ["-af", fades.join(",")] : []), ...(AUDIO_ENC[e] || AUDIO_ENC.mp3), `out.${AUDIO_ENC[e] ? e : "mp3"}`] });
    if (out === "same" && !fades.length) return { ext, label: "Cutting…", args: [...ss, "-map", "0:a:0", "-c", "copy", `out.${ext}`], fallback: reencode(AUDIO_ENC[ext] ? ext : "mp3") };
    const r = reencode(AUDIO_ENC[target] ? target : "mp3"); r.ext = AUDIO_ENC[target] ? target : "mp3";
    return { ...r, label: "Encoding…" };
  }

  return { unmount() { alive = false; player.pause(); } };
}
