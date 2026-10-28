// Shared ONNX Runtime loader: WebGPU when the browser has it, WebAssembly otherwise.
import { CDN } from "./config.js";

let ortP = null;
export function getOrt() {
  return (ortP ||= (async () => {
    let gpu = false;
    try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch {}
    const ort = await import(CDN.ortDir + (gpu ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
    ort.env.wasm.wasmPaths = CDN.ortDir;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    return { ort, gpu };
  })());
}

export async function fetchModel(url, onP, est) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Model download failed (${r.status})`);
  const total = Number(r.headers.get("content-length")) || est || 1;
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onP?.(Math.min(1, got / total)); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

const sessions = new Map();
/** Cached InferenceSession for a model URL. */
export function session(url, onStatus = () => {}, label = "AI model", est) {
  if (sessions.has(url)) return sessions.get(url);
  const p = (async () => {
    const { ort, gpu } = await getOrt();
    const model = await fetchModel(url, (x) => onStatus(`Downloading the ${label} (only the first time)… ${Math.round(x * 100)}%`), est);
    onStatus("Starting the AI engine…");
    for (const ep of gpu ? ["webgpu", "wasm"] : ["wasm"]) {
      try { return { ort, s: await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: "all" }), backend: ep }; }
      catch (e) { console.warn(`ORT ${ep} failed`, e); }
    }
    throw new Error("The AI engine couldn't start in this browser.");
  })();
  p.catch(() => sessions.delete(url));
  sessions.set(url, p);
  return p;
}
