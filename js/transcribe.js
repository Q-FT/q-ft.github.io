// Transcribe audio & video: upload a file, paste a direct media link, or record with the microphone.
// Whisper runs in a worker (js/transcribe-worker.js). The transcript is editable, searchable, click-to-seek,
// and exports to TXT, Word, PDF, SRT, VTT, Markdown and JSON. Nothing is uploaded.
import { CDN } from "./config.js";
import { $, esc, fmtBytes, baseName, dropzone, segmented, opt, button, download, toast } from "./ui.js";

const MODELS = { fast: { id: "onnx-community/whisper-base", label: "Fast", mb: 80 }, accurate: { id: "onnx-community/whisper-small", label: "Accurate", mb: 250 } };
const LANGS = [["auto", "Detect automatically"], ["english", "English"], ["french", "French"], ["spanish", "Spanish"], ["portuguese", "Portuguese"], ["german", "German"], ["italian", "Italian"], ["dutch", "Dutch"], ["arabic", "Arabic"], ["chinese", "Chinese"], ["japanese", "Japanese"], ["korean", "Korean"], ["hindi", "Hindi"], ["russian", "Russian"], ["ukrainian", "Ukrainian"], ["polish", "Polish"], ["turkish", "Turkish"], ["vietnamese", "Vietnamese"], ["swahili", "Swahili"]];
const BLOCKED = /(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|spotify\.com|soundcloud\.com)/i;
const el = (tag, cls, html) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, html != null ? { innerHTML: html } : {});

// ---------------------------------------------------------------- audio: any file -> 16 kHz mono
async function toPcm(blob, setStatus) {
  const buf = await blob.arrayBuffer();
  try {
    const ctx = new OfflineAudioContext(1, 1, 16000); // decodeAudioData resamples to the context rate
    return mono(await ctx.decodeAudioData(buf.slice(0)));
  } catch {
    setStatus("Converting the file…");
    const { engine } = await import("./media.js");
    const ff = await engine(setStatus);
    await ff.writeFile("tin", new Uint8Array(buf));
    const code = await ff.exec(["-i", "tin", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "tout.wav"]);
    if (code !== 0) throw new Error("This file has no audio we can read.");
    const wav = await ff.readFile("tout.wav"); ff.deleteFile("tin").catch(() => {}); ff.deleteFile("tout.wav").catch(() => {});
    return mono(await new OfflineAudioContext(1, 1, 16000).decodeAudioData(wav.buffer));
  }
}
function mono(ab) {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0).slice();
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels; }
  return out;
}

// ---------------------------------------------------------------- exports
const ts = (s, sep = ",", hours = true) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${hours || h ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}${sep === null ? "" : sep + String(ms).padStart(3, "0")}`; };
const short = (s) => ts(s, null, false);
const paragraphs = (segs) => { // join sentences into readable paragraphs (new paragraph after a pause or every ~5 sentences)
  const out = []; let cur = [], n = 0, prevEnd = 0;
  for (const s of segs) { if (cur.length && (s.start - prevEnd > 2 || (n >= 5 && /[.!?…]$/.test(cur.at(-1).text)))) { out.push(cur); cur = []; n = 0; } cur.push(s); n += (s.text.match(/[.!?…]/g) || []).length; prevEnd = s.end; }
  if (cur.length) out.push(cur); return out;
};
const EXPORTS = {
  txt: (segs, o) => new Blob([o.times ? segs.map((s) => `[${short(s.start)}] ${s.text}`).join("\n") : paragraphs(segs).map((p) => p.map((s) => s.text).join(" ")).join("\n\n")], { type: "text/plain" }),
  srt: (segs) => new Blob([segs.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text}\n`).join("\n")], { type: "application/x-subrip" }),
  vtt: (segs) => new Blob(["WEBVTT\n\n" + segs.map((s) => `${ts(s.start, ".")} --> ${ts(s.end, ".")}\n${s.text}\n`).join("\n")], { type: "text/vtt" }),
  md: (segs, o) => new Blob([`# ${o.title}\n\n` + (o.times ? segs.map((s) => `**[${short(s.start)}]** ${s.text}`).join("\n\n") : paragraphs(segs).map((p) => `**[${short(p[0].start)}]** ${p.map((s) => s.text).join(" ")}`).join("\n\n")) + "\n"], { type: "text/markdown" }),
  json: (segs, o) => new Blob([JSON.stringify({ title: o.title, language: o.language, segments: segs.map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), text: s.text })) }, null, 2)], { type: "application/json" }),
  docx: async (segs, o) => {
    const { zipSync, strToU8 } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
    const x = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const run = (t, bold, color) => `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
    const body = [`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run(o.title, true)}</w:p>`, `<w:p>${run(`Transcribed with Q-FT · ${new Date().toLocaleDateString()}`, false, "777777")}</w:p>`,
      ...(o.times ? segs.map((s) => `<w:p>${run(`[${short(s.start)}] `, true, "4F46E5")}${run(s.text)}</w:p>`) : paragraphs(segs).map((p) => `<w:p>${run(`[${short(p[0].start)}] `, true, "4F46E5")}${run(p.map((s) => s.text).join(" "))}</w:p>`))].join("");
    const files = {
      "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
      "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/_rels/document.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
      "word/styles.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="23"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style></w:styles>'),
      "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200"/></w:sectPr></w:body></w:document>`),
    };
    return new Blob([zipSync(files)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  },
  pdf: async (segs, o) => {
    const { PDFDocument, StandardFonts, rgb } = await import(CDN.pdfLib);
    const doc = await PDFDocument.create(), all = segs.map((s) => s.text).join(" ") + o.title;
    let font, bold;
    if (/^[\x20-\x7E\xA0-\xFF‘’“”–—…€\s]*$/.test(all)) { font = await doc.embedFont(StandardFonts.Helvetica); bold = await doc.embedFont(StandardFonts.HelveticaBold); }
    else { // other alphabets: Noto Sans covers Latin, Cyrillic, Greek and Vietnamese
      if (/[֐-ࣿ฀-࿿ᄀ-ᇿ　-鿿가-힯]/.test(all)) throw new Error("PDF export doesn't support this alphabet yet. Use Word or TXT.");
      const fontkit = (await import("https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.es.min.js")).default; doc.registerFontkit(fontkit);
      const bytes = await (await fetch("https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf")).arrayBuffer();
      font = bold = await doc.embedFont(bytes, { subset: true });
    }
    const clean = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...");
    const W = 612, H = 792, M = 60; let page = doc.addPage([W, H]), y = H - M;
    const wrap = (t, f, size, w) => { const lines = []; let line = ""; for (const word of clean(t).split(/\s+/)) { const tt = line ? `${line} ${word}` : word; if (f.widthOfTextAtSize(tt, size) > w && line) { lines.push(line); line = word; } else line = tt; } if (line) lines.push(line); return lines; };
    const write = (t, { f = font, size = 11, color = rgb(0.1, 0.1, 0.15), x = M, gap = 4 } = {}) => { for (const l of wrap(t, f, size, W - x - M)) { if (y < M + size) { page = doc.addPage([W, H]); y = H - M; } page.drawText(l, { x, y: y - size, size, font: f, color }); y -= size + gap; } };
    write(o.title, { f: bold, size: 18 }); write(`Transcribed with Q-FT · ${new Date().toLocaleDateString()}`, { size: 9, color: rgb(0.45, 0.45, 0.5) }); y -= 10;
    for (const p of o.times ? segs.map((s) => [s]) : paragraphs(segs)) { write(`[${short(p[0].start)}]`, { f: bold, size: 9, color: rgb(0.31, 0.27, 0.9), gap: 2 }); write(p.map((s) => s.text).join(" ")); y -= 6; }
    return new Blob([await doc.save()], { type: "application/pdf" });
  },
};

// ---------------------------------------------------------------- page
export function mount(panel) {
  let source = "file", model = "fast", task = "transcribe", lang = "auto", media = null, mediaName = "recording", segs = [], worker = null, recorder = null;
  const pick = el("div"); const opts = el("div", "opts"), status = el("div", "status"); status.hidden = true;
  const bar = el("div", "bar"); bar.innerHTML = "<i></i>"; bar.hidden = true;
  const go = button("Transcribe", "btn btn--primary btn--lg"); go.disabled = true;
  const result = el("div"); result.hidden = true;
  const setStatus = (m) => { status.hidden = !m; status.innerHTML = m ? `<span class="spin"></span>${esc(m)}` : ""; };
  const chosen = el("div", "jobs");

  // sources
  const dz = dropzone({ accept: "audio/*,video/*,.mkv,.mov,.m4a,.opus,.flac,.amr,.3gp", title: "Drop an audio or video file", sub: "MP4, MOV, WebM, MKV, MP3, WAV, M4A, OGG… stays on your device", onFiles: ([f]) => setMedia(f, f.name) });
  const linkBox = el("div", "linkbox", `<input type="url" placeholder="https://example.com/interview.mp3" aria-label="Media link" /><p class="hint">Paste a <b>direct link to an audio or video file</b> (ending in .mp3, .mp4, .m4a…). It works when the site allows it. YouTube, TikTok and Instagram links can't be used: if it's your own video, download it from the app and upload the file.</p>`);
  const linkBtn = button("Get the file", "btn btn--ghost"); linkBox.insertBefore(linkBtn, linkBox.querySelector(".hint"));
  const recBox = el("div", "recbox", `<button type="button" class="rec" aria-label="Record"><span></span></button><div><b data-rt>Tap to record</b><p class="hint" style="margin:4px 0 0">Records from your microphone: meetings, lectures, voice notes.</p></div>`);
  const tabs = segmented([["file", "Upload a file"], ["link", "Paste a link"], ["record", "Record"]], source, (v) => { source = v; showSource(); });
  const showSource = () => { dz.hidden = source !== "file"; linkBox.hidden = source !== "link"; recBox.hidden = source !== "record"; };
  pick.append(tabs.el, dz, linkBox, recBox); showSource();

  const langSel = Object.assign(document.createElement("select"), { innerHTML: LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("") });
  langSel.onchange = () => (lang = langSel.value);
  opts.append(opt("Language spoken", langSel), opt("Output", segmented([["transcribe", "Same language"], ["translate", "Translate to English"]], task, (v) => (task = v)).el),
    opt("Quality", segmented(Object.entries(MODELS).map(([k, m]) => [k, `${m.label} · ${m.mb} MB`]), model, (v) => (model = v)).el));
  const actions = el("div", "row-end"); actions.append(go);
  panel.append(pick, chosen, opts, el("p", "hint", "Runs on your device, nothing is uploaded. The AI model downloads once, then works offline. A graphics card (Chrome, Edge, recent Safari) makes it much faster."), actions, status, bar, result);

  function setMedia(blob, name) {
    media = blob; mediaName = baseName(name || "recording");
    chosen.innerHTML = `<div class="job"><div class="job__thumb">${blob.type.startsWith("video") ? "▶" : "♪"}</div><div><div class="job__name">${esc(name)}</div><div class="job__meta">${fmtBytes(blob.size)} · ready to transcribe</div></div></div>`;
    go.disabled = false; result.hidden = true;
  }

  linkBtn.onclick = async () => {
    const url = linkBox.querySelector("input").value.trim();
    if (!/^https?:\/\//i.test(url)) return toast("Paste a full link starting with https://");
    if (BLOCKED.test(url)) return toast("Links from YouTube, TikTok, Instagram and similar sites can't be used. Download your own video and upload the file.", 7000);
    linkBtn.disabled = true; setStatus("Getting the file…");
    try {
      const r = await fetch(url); if (!r.ok) throw new Error(`The link returned an error (${r.status}).`);
      const type = r.headers.get("content-type") || "";
      if (/text\/html/.test(type)) throw new Error("That link opens a web page, not a media file. Use a direct link to the file.");
      const blob = await r.blob(); setMedia(blob, decodeURIComponent(url.split("/").pop().split("?")[0]) || "linked-media");
    } catch (e) { toast(/fetch|network|cors/i.test(e.message) ? "That site doesn't allow other websites to download its files. Download it yourself and upload it here." : e.message, 7000); }
    finally { linkBtn.disabled = false; setStatus(""); }
  };

  const recBtn = recBox.querySelector(".rec"), recLabel = recBox.querySelector("[data-rt]");
  recBtn.onclick = async () => {
    if (recorder?.state === "recording") { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const parts = []; recorder = new MediaRecorder(stream); const t0 = Date.now();
      const tick = setInterval(() => (recLabel.textContent = `Recording… ${short((Date.now() - t0) / 1000)} · tap to stop`), 250);
      recorder.ondataavailable = (e) => parts.push(e.data);
      recorder.onstop = () => { clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); recBtn.classList.remove("on"); recLabel.textContent = "Tap to record again"; setMedia(new Blob(parts, { type: recorder.mimeType || "audio/webm" }), `recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`); };
      recorder.start(1000); recBtn.classList.add("on");
    } catch { toast("Microphone access was blocked. Allow it in your browser settings to record."); }
  };

  go.onclick = async () => {
    if (!media) return;
    go.disabled = true; result.hidden = true; segs = [];
    const t0 = performance.now();
    try {
      setStatus("Reading the audio…");
      const audio = await toPcm(media, setStatus), seconds = audio.length / 16000;
      if (seconds < 0.5) throw new Error("This file has no audible audio.");
      if (seconds > 3 * 3600) throw new Error("That's over 3 hours. Split it into shorter parts first (Trim Audio).");
      let gpu = false; try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch {}
      worker?.terminate(); worker = new Worker(new URL("./transcribe-worker.js", import.meta.url), { type: "module" });
      renderResult(seconds); bar.hidden = false; bar.firstChild.style.width = "0%";
      setStatus(`Loading the speech model (${MODELS[model].mb} MB the first time)…`);
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data: m }) => {
          if (m.type === "download") setStatus(`Downloading the speech model (${m.mb} MB, only once)… ${Math.round(m.progress * 100)}%`);
          else if (m.type === "ready") setStatus(m.gpu ? "Transcribing on your graphics card…" : "Transcribing on your processor (a graphics card is much faster)…");
          else if (m.type === "partial") {
            segs.push(...m.chunks); addSegments(m.chunks); bar.firstChild.style.width = `${Math.round(m.progress * 100)}%`;
            const el2 = (performance.now() - t0) / 1000, left = el2 / m.progress - el2;
            setStatus(`Transcribing… ${Math.round(m.progress * 100)}%${m.progress < 1 && el2 > 8 ? ` · about ${Math.max(1, Math.round(left / 60))} min left` : ""}`);
          } else if (m.type === "done") resolve(); else if (m.type === "error") reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || "The speech engine stopped."));
        worker.postMessage({ type: "run", audio, model: MODELS[model].id, language: lang, task, gpu }, [audio.buffer]);
      });
      bar.hidden = true;
      if (!segs.length) throw new Error("No speech was found in this file.");
      setStatus(""); finishResult(seconds, (performance.now() - t0) / 1000);
    } catch (e) { console.error(e); setStatus(""); bar.hidden = true; toast(e.message || "Transcription failed", 6000); }
    finally { go.disabled = false; }
  };

  // ---- result view
  let list, player;
  function renderResult(seconds) {
    result.hidden = false;
    const url = URL.createObjectURL(media), isVideo = media.type.startsWith("video");
    result.innerHTML = `<div class="tx"><div class="tx__media"></div><div class="tx__side">
      <div class="tx__tools"><input type="search" placeholder="Search the transcript…" aria-label="Search" /><span class="muted small" data-stats></span></div>
      <div class="tx__list" aria-live="polite"></div></div></div>
      <div class="tx__export" hidden><span class="muted small">Download as</span><div class="swatches" data-dl></div><label class="check"><input type="checkbox" data-times /> One line per timestamp</label></div>`;
    player = Object.assign(document.createElement(isVideo ? "video" : "audio"), { src: url, controls: true, className: "player", playsInline: true });
    $(".tx__media", result).append(player);
    list = $(".tx__list", result);
    $("[data-stats]", result).textContent = `${short(seconds)} long`;
    $(".tx__tools input", result).oninput = (e) => { const q = e.target.value.trim().toLowerCase(); list.querySelectorAll(".tline").forEach((s) => s.classList.toggle("dim", !!q && !s.textContent.toLowerCase().includes(q))); };
    player.ontimeupdate = () => { const t = player.currentTime; list.querySelectorAll(".tline").forEach((s) => s.classList.toggle("now", t >= +s.dataset.s && t < +s.dataset.e)); };
  }
  function addSegments(chunks) {
    for (const s of chunks) {
      const row = el("div", "tline"); row.dataset.s = s.start; row.dataset.e = s.end;
      row.innerHTML = `<button type="button" class="tline__t">${short(s.start)}</button><span class="tline__x" contenteditable="true" spellcheck="true"></span>`;
      row.lastChild.textContent = s.text;
      row.firstChild.onclick = () => { player.currentTime = s.start; player.play(); };
      row.lastChild.oninput = () => { s.text = row.lastChild.textContent.trim(); };
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }
  function finishResult(seconds, took) {
    const words = segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    $("[data-stats]", result).textContent = `${short(seconds)} · ${words.toLocaleString()} words · done in ${took < 90 ? Math.round(took) + " s" : Math.round(took / 60) + " min"} · click any text to edit it`;
    const exp = $(".tx__export", result); exp.hidden = false;
    const times = $("[data-times]", result), o = () => ({ title: mediaName.replace(/[-_]+/g, " "), times: times.checked, language: lang });
    const fmts = [["docx", "Word"], ["pdf", "PDF"], ["txt", "TXT"], ["srt", "SRT subtitles"], ["vtt", "VTT subtitles"], ["md", "Markdown"], ["json", "JSON"]];
    $("[data-dl]", result).append(...fmts.map(([k, l]) => button(l, k === "docx" ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm", async () => {
      try { download(await EXPORTS[k](segs.filter((s) => s.text), o()), `${mediaName}_transcript.${k}`); } catch (e) { toast(e.message, 6000); }
    })), button("Copy text", "btn btn--ghost btn--sm", async () => { await navigator.clipboard.writeText(await (await EXPORTS.txt(segs, o())).text()); toast("Transcript copied"); }));
  }

  return { unmount() { worker?.terminate(); if (recorder?.state === "recording") recorder.stop(); } };
}
