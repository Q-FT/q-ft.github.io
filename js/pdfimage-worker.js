// Worker for Compress PDF: decodes, resizes and re-encodes one picture at a time (see pdfimage.js).
import { processImage } from "./pdfimage.js";

self.onmessage = async ({ data: { id, job } }) => {
  try {
    const out = await processImage(job);
    const transfer = out ? Object.values(out).map((o) => o.jpg.buffer) : [];
    self.postMessage({ id, out }, transfer);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
