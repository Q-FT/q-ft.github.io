// Audio & video toolbox on ffmpeg.wasm: convert, compress, merge, speed, volume, rotate, resize/crop,
// noise removal, GIF, extract audio, mute. Shares the engine with the trimmer (media.js).
import { engine, ffrun } from "./media.js";
import { $, esc, fmtBytes, baseName, extOf, dropzone, segmented, opt, jobRow, button, download, toast } from "./ui.js";

const el = (tag, cls, html) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, html != null ? { innerHTML: html } : {});
const MIME = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", gif: "image/gif" };
const AENC = { mp3: ["-c:a", "libmp3lame", "-q:a", "0"], wav: ["-c:a", "pcm_s16le"], m4a: ["-c:a", "aac", "-b:a", "256k"], flac: ["-c:a", "flac"], ogg: ["-c:a", "libvorbis", "-q:a", "6"] };
const X264 = (crf = 20) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const AAC = ["-c:a", "aac", "-b:a", "192k"];

/** What's inside a media file: duration, video size, audio codec (read from ffmpeg's own report). */
async function probe(ff, name) {
  const logs = []; const on = ({ message }) => logs.push(message);
  ff.on("log", on); try { await ff.exec(["-hide_banner", "-i", name]); } catch {} finally { ff.off("log", on); }
  const t = logs.join("\n"), d = t.match(/Duration: (\d+):(\d+):([\d.]+)/), v = t.match(/Video: [^\n]*?(\d{2,5})x(\d{2,5})/), a = t.match(/Audio: (\w+)/);
  return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, video: v ? { w: +v[1], h: +v[2] } : null, audio: a ? a[1] : null };
}
const atempo = (f) => { const parts = []; let x = f; while (x > 2) { parts.push("atempo=2"); x /= 2; } while (x < 0.5) { parts.push("atempo=0.5"); x /= 0.5; } parts.push(`atempo=${x.toFixed(4)}`); return parts.join(","); };

/** Generic page: drop file(s), options, run. plan(ctx) -> { ext, args, label } or array of plans to try in order. */
function tool(panel, { accept, multiple = false, title, sub, cta, options, plan, note }) {
  const st = {}, files = [], opts = el("div", "opts"), list = el("div", "jobs"), res = el("div"), status = el("div", "status"); status.hidden = true;
  const set = (m) => { status.hidden = !m; status.innerHTML = m ? `<span class="spin"></span>${esc(m)}` : ""; };
  const go = button(cta, "btn btn--primary btn--lg"); go.disabled = true;
  const actions = el("div", "row-end"); actions.append(go);
  options?.(opts, st);
  const draw = () => {
    list.replaceChildren(...files.map((f, i) => {
      const r = jobRow(f.name, f.type.startsWith("audio") ? "♪" : "▶"); r.progress(null); r.meta(fmtBytes(f.size));
      r.actions(...(multiple ? [button("↑", "btn btn--ghost btn--sm", () => mv(i, -1)), button("↓", "btn btn--ghost btn--sm", () => mv(i, 1))] : []), button("✕", "btn btn--ghost btn--sm", () => { files.splice(i, 1); draw(); }));
      return r.el;
    }));
    go.disabled = files.length < (multiple ? 2 : 1);
  };
  const mv = (i, d) => { const j = i + d; if (j < 0 || j >= files.length) return; [files[i], files[j]] = [files[j], files[i]]; draw(); };
  panel.append(dropzone({ accept, multiple, title, sub, onFiles: (fs) => { if (!multiple) files.length = 0; files.push(...fs); draw(); } }), list, opts);
  if (note) panel.append(el("p", "hint", note));
  panel.append(actions, status, res);
  go.addEventListener("click", async () => {
    go.disabled = true; res.replaceChildren();
    try {
      const big = files.reduce((a, f) => a + f.size, 0); if (big > 1.5e9) throw new Error("Those files are over 1.5 GB, too big to edit in a browser.");
      const ff = await engine(set);
      const names = [];
      for (const [i, f] of files.entries()) { set(`Reading ${f.name}…`); const n = `in${i}.${extOf(f.name) || "bin"}`; await ff.writeFile(n, new Uint8Array(await f.arrayBuffer())); names.push(n); }
      const info = []; for (const n of names) info.push(await probe(ff, n));
      const plans = [].concat(await plan({ files, names, info, st }));
      let bytes = null, used = null;
      for (const p of plans) {
        try { set(p.label); const total = p.duration ?? info.reduce((a, x) => a + x.duration, 0); bytes = await ffrun(ff, p.args, `out.${p.ext}`, total, (x) => set(`${p.label} ${Math.round(x * 100)}%`)); used = p; break; }
        catch (e) { console.warn("plan failed", p.label, e); }
      }
      for (const n of names) ff.deleteFile(n).catch(() => {});
      if (!bytes) throw new Error("That didn't work with this file. Try another format.");
      ff.deleteFile(`out.${used.ext}`).catch(() => {});
      const blob = new Blob([bytes], { type: MIME[used.ext] || "application/octet-stream" }), name = `${baseName(files[0].name)}_${used.suffix || "q-ft"}.${used.ext}`;
      const row = jobRow(name, "✓"); row.progress(null);
      row.meta(`<span class="ok">Done</span> · ${fmtBytes(big)} → <b>${fmtBytes(blob.size)}</b>`);
      row.actions(button("Download", "btn btn--primary btn--sm", () => download(blob, name)));
      const url = URL.createObjectURL(blob), kind = used.ext === "gif" ? "img" : MIME[used.ext]?.startsWith("video") ? "video" : "audio";
      const preview = Object.assign(document.createElement(kind), kind === "img" ? { src: url, className: "gifout" } : { src: url, controls: true, className: "player" });
      res.append(row.el, preview);
    } catch (e) { console.error(e); toast(e.message || "Something went wrong", 5000); }
    finally { set(""); go.disabled = false; }
  });
}

const V = "video/*,.mkv,.mov", A = "audio/*,.m4a,.flac,.opus,.ogg", AV = `${V},${A}`;
const MODES = {
  "convert-video": (p) => tool(p, {
    accept: V, title: "Drop a video", sub: "MP4, MOV, WebM, MKV, AVI…", cta: "Convert",
    options: (o, st) => { st.to = "mp4"; o.append(opt("Convert to", segmented([["mp4", "MP4"], ["mov", "MOV"], ["mkv", "MKV"], ["webm", "WebM"], ["gif", "GIF"]], "mp4", (v) => (st.to = v)).el)); },
    note: "When the video's format allows it, conversion is instant and lossless. Otherwise it's re-encoded at high quality.",
    plan: ({ names: [n], st }) => {
      const to = st.to, s = "converted";
      if (to === "gif") return { ext: "gif", suffix: s, label: "Making the GIF…", args: ["-i", n, "-vf", "fps=12,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", "out.gif"] };
      if (to === "webm") return { ext: "webm", suffix: s, label: "Encoding WebM…", args: ["-i", n, "-c:v", "libvpx", "-crf", "10", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libvorbis", "out.webm"] };
      return [{ ext: to, suffix: s, label: "Converting…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", ...(to === "mp4" || to === "mov" ? ["-movflags", "+faststart"] : []), `out.${to}`] },
        { ext: to, suffix: s, label: "Re-encoding at high quality…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", ...X264(20), ...AAC, `out.${to}`] }];
    },
  }),
  "compress-video": (p) => tool(p, {
    accept: V, title: "Drop a video to shrink", sub: "Great for WhatsApp, email and uploads", cta: "Compress video",
    options: (o, st) => { st.q = 28; st.h = 0; o.append(opt("Quality", segmented([[23, "High"], [28, "Balanced"], [33, "Smallest"]], 28, (v) => (st.q = v)).el), opt("Max resolution", segmented([[0, "Keep"], [1080, "1080p"], [720, "720p"], [480, "480p"]], 0, (v) => (st.h = v)).el)); },
    note: "Compression re-encodes the video, so it takes a while for long clips. 720p Balanced is a great choice for phones.",
    plan: ({ names: [n], info: [i], st }) => {
      const vf = st.h && i.video && Math.min(i.video.w, i.video.h) > st.h ? ["-vf", i.video.w >= i.video.h ? `scale=-2:${st.h}` : `scale=${st.h}:-2`] : [];
      return { ext: "mp4", suffix: "compressed", label: "Compressing…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", ...vf, ...X264(st.q), "-c:a", "aac", "-b:a", "128k", "out.mp4"] };
    },
  }),
  "convert-audio": (p) => tool(p, {
    accept: AV, title: "Drop an audio file (or a video)", sub: "MP3, WAV, M4A, FLAC, OGG, and more", cta: "Convert",
    options: (o, st) => { st.to = "mp3"; st.kbps = 192; const br = opt("MP3 quality", segmented([[128, "128 kbps"], [192, "192 kbps"], [320, "320 kbps"]], 192, (v) => (st.kbps = v)).el); o.append(opt("Convert to", segmented([["mp3", "MP3"], ["m4a", "M4A"], ["wav", "WAV"], ["flac", "FLAC"], ["ogg", "OGG"]], "mp3", (v) => { st.to = v; br.hidden = v !== "mp3"; }).el), br); },
    plan: ({ names: [n], st }) => ({ ext: st.to, suffix: "converted", label: "Converting…", args: ["-i", n, "-vn", "-map", "0:a:0", ...(st.to === "mp3" ? ["-c:a", "libmp3lame", "-b:a", `${st.kbps}k`] : AENC[st.to]), `out.${st.to}`] }),
  }),
  "merge-media": (p) => tool(p, {
    accept: AV, multiple: true, title: "Drop the clips or songs to join", sub: "Put them in order with the arrows", cta: "Merge",
    note: "Videos of different sizes are fitted to the first one, with black bars if needed.",
    plan: ({ files, names, info }) => {
      const allAudio = info.every((x) => !x.video);
      if (allAudio) {
        const ext = AENC[extOf(files[0].name)] ? extOf(files[0].name) : "mp3";
        const ins = names.flatMap((n) => ["-i", n]), f = names.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`).join(";") + ";" + names.map((_, i) => `[a${i}]`).join("") + `concat=n=${names.length}:v=0:a=1[a]`;
        return { ext, suffix: "merged", label: "Joining…", args: [...ins, "-filter_complex", f, "-map", "[a]", ...AENC[ext], `out.${ext}`] };
      }
      const first = info.find((x) => x.video).video, W = first.w - (first.w % 2), H = first.h - (first.h % 2);
      const ins = names.flatMap((n) => ["-i", n]); let extra = names.length; const parts = [];
      info.forEach((x, i) => {
        parts.push(x.video ? `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]` : `color=c=black:s=${W}x${H}:r=30:d=${x.duration.toFixed(2)},format=yuv420p[v${i}]`);
        if (x.audio) parts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
        else { ins.push("-f", "lavfi", "-t", x.duration.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo"); parts.push(`[${extra}:a]aformat=channel_layouts=stereo[a${i}]`); extra++; }
      });
      const f = parts.join(";") + ";" + names.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${names.length}:v=1:a=1[v][a]`;
      return { ext: "mp4", suffix: "merged", label: "Joining the clips…", args: [...ins, "-filter_complex", f, "-map", "[v]", "-map", "[a]", ...X264(21), ...AAC, "out.mp4"] };
    },
  }),
  "change-speed": (p) => tool(p, {
    accept: AV, title: "Drop a video or audio file", sub: "Slow motion or fast forward", cta: "Change speed",
    options: (o, st) => { st.f = 2; o.append(opt("Speed", segmented([[0.25, "0.25×"], [0.5, "0.5×"], [0.75, "0.75×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"], [4, "4×"]], 2, (v) => (st.f = v)).el)); },
    plan: ({ files: [f], names: [n], info: [i], st }) => {
      const dur = i.duration / st.f;
      if (!i.video) { const ext = AENC[extOf(f.name)] ? extOf(f.name) : "mp3"; return { ext, duration: dur, suffix: `${st.f}x`, label: "Changing speed…", args: ["-i", n, "-filter:a", atempo(st.f), ...AENC[ext], `out.${ext}`] }; }
      return { ext: "mp4", duration: dur, suffix: `${st.f}x`, label: "Changing speed…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", "-filter:v", `setpts=PTS/${st.f}`, ...(i.audio ? ["-filter:a", atempo(st.f), ...AAC] : []), ...X264(20), "out.mp4"] };
    },
  }),
  "adjust-volume": (p) => tool(p, {
    accept: AV, title: "Drop a video or audio file", sub: "Louder, quieter or evenly leveled", cta: "Apply",
    options: (o, st) => { st.v = "6"; o.append(opt("Volume", segmented([["-6", "Quieter"], ["3", "+3 dB"], ["6", "+6 dB"], ["10", "+10 dB"], ["norm", "Normalize"]], "6", (v) => (st.v = v)).el)); },
    note: "Normalize evens out loud and quiet parts to a standard level, like streaming services do.",
    plan: ({ files: [f], names: [n], info: [i], st }) => {
      // loudnorm works at 192 kHz internally: bring it back to 44.1 kHz
      const af = st.v === "norm" ? "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100" : `volume=${st.v}dB,alimiter=limit=0.97`;
      if (!i.audio) throw new Error("This file has no sound.");
      if (!i.video) { const ext = AENC[extOf(f.name)] ? extOf(f.name) : "mp3"; return { ext, suffix: "volume", label: "Adjusting volume…", args: ["-i", n, "-af", af, ...AENC[ext], `out.${ext}`] }; }
      const ext = ["mp4", "mov", "mkv"].includes(extOf(f.name)) ? extOf(f.name) : "mp4";
      return { ext, suffix: "volume", label: "Adjusting volume…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", af, ...AAC, `out.${ext}`] };
    },
  }),
  "rotate-video": (p) => tool(p, {
    accept: V, title: "Drop a video", sub: "Fix sideways or mirrored videos", cta: "Rotate",
    options: (o, st) => { st.r = "transpose=1"; o.append(opt("Turn", segmented([["transpose=1", "↻ 90°"], ["transpose=2", "↺ 90°"], ["transpose=1,transpose=1", "180°"], ["hflip", "⇆ Mirror"], ["vflip", "⇅ Flip"]], st.r, (v) => (st.r = v)).el)); },
    plan: ({ names: [n], st }) => ({ ext: "mp4", suffix: "rotated", label: "Rotating…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", "-vf", st.r, ...X264(19), ...AAC, "out.mp4"] }),
  }),
  "resize-video": (p) => tool(p, {
    accept: V, title: "Drop a video", sub: "Resize or crop for any platform", cta: "Resize",
    options: (o, st) => { st.k = "720"; o.append(opt("Size", segmented([["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["sq", "Square 1:1"], ["vert", "Vertical 9:16"], ["wide", "Wide 16:9"]], "720", (v) => (st.k = v)).el)); },
    note: "Square, vertical and wide crop the center of the video.",
    plan: ({ names: [n], info: [i], st }) => {
      const vf = { 1080: "scale=-2:1080", 720: "scale=-2:720", 480: "scale=-2:480", sq: "crop='min(iw,ih)':'min(iw,ih)'", vert: "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=-2:'min(1920,ih)'", wide: "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)'" }[st.k];
      const tall = i.video && i.video.h > i.video.w && ["1080", "720", "480"].includes(st.k) ? vf.replace(/scale=-2:(\d+)/, "scale=$1:-2") : vf;
      return { ext: "mp4", suffix: st.k, label: "Resizing…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a?", "-vf", `${tall},setsar=1`, ...X264(20), ...AAC, "out.mp4"] };
    },
  }),
  "denoise-audio": (p) => tool(p, {
    accept: AV, title: "Drop a recording", sub: "Voice notes, interviews, lectures, videos", cta: "Remove noise",
    options: (o, st) => { st.s = -25; o.append(opt("Strength", segmented([[-20, "Light"], [-25, "Medium"], [-32, "Strong"]], -25, (v) => (st.s = v)).el)); },
    plan: ({ files: [f], names: [n], info: [i], st }) => {
      if (!i.audio) throw new Error("This file has no sound.");
      const af = `highpass=f=70,lowpass=f=14000,afftdn=nf=${st.s}:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100`;
      if (!i.video) { const ext = AENC[extOf(f.name)] ? extOf(f.name) : "mp3"; return { ext, suffix: "clean", label: "Cleaning the sound…", args: ["-i", n, "-af", af, ...AENC[ext], `out.${ext}`] }; }
      return { ext: "mp4", suffix: "clean", label: "Cleaning the sound…", args: ["-i", n, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", af, ...AAC, "out.mp4"] };
    },
  }),
  "video-to-gif": (p) => tool(p, {
    accept: V, title: "Drop a short video", sub: "Best under 15 seconds", cta: "Make GIF",
    options: (o, st) => {
      Object.assign(st, { fps: 15, w: 480, start: 0, len: 6 });
      const s = Object.assign(document.createElement("input"), { type: "number", value: 0, min: 0, step: 0.5 }), l = Object.assign(document.createElement("input"), { type: "number", value: 6, min: 0.5, max: 60, step: 0.5 });
      s.style.width = l.style.width = "100px"; s.oninput = () => (st.start = +s.value || 0); l.oninput = () => (st.len = +l.value || 6);
      o.append(opt("Smoothness", segmented([[10, "10 fps"], [15, "15 fps"], [20, "20 fps"]], 15, (v) => (st.fps = v)).el), opt("Width", segmented([[320, "320"], [480, "480"], [640, "640"], [800, "800"]], 480, (v) => (st.w = v)).el), opt("Start (s)", s), opt("Length (s)", l));
    },
    plan: ({ names: [n], st }) => ({ ext: "gif", duration: st.len, suffix: "gif", label: "Making the GIF…", args: ["-ss", String(st.start), "-t", String(st.len), "-i", n, "-vf", `fps=${st.fps},scale='min(${st.w},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0", "out.gif"] }),
  }),
  "extract-audio": (p) => tool(p, {
    accept: V, title: "Drop a video", sub: "Save its sound as an audio file", cta: "Extract audio",
    options: (o, st) => { st.to = "mp3"; o.append(opt("Save as", segmented([["mp3", "MP3"], ["m4a", "M4A"], ["wav", "WAV"]], "mp3", (v) => (st.to = v)).el)); },
    plan: ({ names: [n], info: [i], st }) => {
      if (!i.audio) throw new Error("This video has no sound.");
      const copy = st.to === "m4a" && i.audio === "aac"; // already AAC: copy it, no quality loss
      return { ext: st.to, suffix: "audio", label: "Extracting…", args: ["-i", n, "-vn", "-map", "0:a:0", ...(copy ? ["-c:a", "copy"] : AENC[st.to]), `out.${st.to}`] };
    },
  }),
  "mute-video": (p) => tool(p, {
    accept: V, title: "Drop a video", sub: "The picture stays untouched", cta: "Remove sound",
    plan: ({ files: [f], names: [n] }) => { const ext = ["mp4", "mov", "mkv", "webm"].includes(extOf(f.name)) ? extOf(f.name) : "mp4"; return [{ ext, suffix: "muted", label: "Removing the sound…", args: ["-i", n, "-map", "0:v:0", "-c:v", "copy", "-an", `out.${ext}`] }, { ext: "mp4", suffix: "muted", label: "Re-encoding…", args: ["-i", n, "-map", "0:v:0", ...X264(19), "-an", "out.mp4"] }]; },
  }),
};

export function mount(panel, mode) {
  const M = MODES[mode]; if (!M) { panel.textContent = "Unknown tool"; return; }
  M(panel);
}
void $;
