// Speech-to-text worker: OpenAI Whisper (MIT) via Transformers.js, on the GPU (WebGPU) or CPU (WebAssembly).
// Audio arrives as 16 kHz mono Float32. It's cut into ~28 s windows at quiet moments (so words aren't split)
// and each window's text is sent back as soon as it's ready.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

env.allowLocalModels = false;
const SR = 16000;
let asr = null, loadedKey = "";
const post = (m) => self.postMessage(m);

async function load(model, gpu) {
  const key = `${model}|${gpu}`;
  if (asr && loadedKey === key) return;
  const files = {};
  asr = await pipeline("automatic-speech-recognition", model, {
    device: gpu ? "webgpu" : "wasm",
    dtype: gpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "q8", decoder_model_merged: "q8" },
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      post({ type: "download", progress: l / t, mb: Math.round(t / 1e6) });
    },
  });
  loadedKey = key;
}

/** Index of the quietest 50 ms between a and b (to cut between words). */
function quietest(audio, a, b) {
  const win = SR / 20; let best = b, min = Infinity;
  for (let i = Math.max(0, a); i + win < b; i += win / 2) {
    let e = 0; for (let j = i; j < i + win; j++) e += audio[j] * audio[j];
    if (e < min) { min = e; best = i + win / 2; }
  }
  return Math.round(best);
}

self.onmessage = async ({ data }) => {
  if (data.type !== "run") return;
  const { audio, model, language, task } = data;
  let gpu = data.gpu;
  try {
    try { await load(model, gpu); }
    catch (e) { if (!gpu) throw e; gpu = false; post({ type: "note", message: "gpu-fallback" }); await load(model, false); }
    post({ type: "ready", gpu });
    const W = 28 * SR, windows = [];
    for (let s = 0; s < audio.length;) {
      let e = Math.min(audio.length, s + W);
      if (e < audio.length) e = quietest(audio, e - 4 * SR, e);
      if (e - s > SR / 4) windows.push([s, e]);
      s = e;
    }
    for (const [i, [s, e]] of windows.entries()) {
      const out = await asr(audio.subarray(s, e), { language: language === "auto" ? null : language, task, return_timestamps: true });
      const dur = (e - s) / SR;
      const chunks = (out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, dur] }])
        .map((c) => ({ start: s / SR + (c.timestamp?.[0] ?? 0), end: s / SR + Math.min(dur, c.timestamp?.[1] ?? dur), text: c.text.trim() }))
        .filter((c) => c.text && !/^\[?(music|musique|silence|blank_audio)\]?$/i.test(c.text));
      post({ type: "partial", chunks, progress: (i + 1) / windows.length });
    }
    post({ type: "done" });
  } catch (e) {
    post({ type: "error", message: e?.message || String(e) });
  }
};
