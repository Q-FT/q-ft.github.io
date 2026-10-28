# Q-FT · Quick File Tools

File tools that run entirely in the browser (nothing is uploaded), hosted free on GitHub Pages.

About 50 tools, all running in the browser. The full list (and the "coming soon" ones) lives in `js/catalog.js`.

| Area | Module | Engine |
|---|---|---|
| AI Photo Enhancer | `js/enhance.js` | Real-ESRGAN `realesr-general-x4v3` (BSD-3) as ONNX in `models/`, ONNX Runtime Web (WebGPU or WebAssembly), tiled 2×/4×. 10 free per device, then packs. |
| Compress PDF | `js/pdf.js` | pdf-lib + pako: recompresses pictures (RGB, gray, CMYK, indexed, 1–8 bit), deflates raw streams; "Extreme" flattens pages to JPEG. |
| PDF toolbox (merge, split, organize, remove/extract/rotate pages, scan, repair, OCR, JPG↔PDF, Markdown, edit, sign, page numbers, watermark, crop, forms, protect/unlock, redact, compare) | `js/pdftools.js` | pdf-lib, PDF.js 4.10 (rendering, text), qpdf-wasm (AES-256), Tesseract.js 5 (OCR). |
| Images (editor, crop, background remover, blur background, face cutout, passport photo, sketch, vectorizer, blur & pixelate, watermark, remove location, compress to size) | `js/imagetools.js`, `js/images.js` | Canvas; MODNet (Apache-2.0, `models/modnet.onnx`) for people cutouts; imagetracerjs for SVG. |
| Audio & video (trim, convert, compress, merge, speed, volume, rotate, resize, denoise, GIF, extract audio, mute) | `js/media.js`, `js/mediatools.js` | ffmpeg.wasm (`vendor/ffmpeg`, core from jsDelivr). |
| QR codes | `js/qr.js` | qr-code-styling. |

## Files
- `index.html`, `css/styles.css`, `js/app.js` (routing, cards), `js/ui.js` (shared helpers)
- tool modules listed above; `js/catalog.js` (every tool, categories, icons); `js/ort.js` (shared ONNX Runtime loader)
- `js/credits.js` (free counter + packs), `js/config.js` (Stripe link, pinned CDN versions)
- tests (open through a local server): `tests/run.html` (core tools), `tests/tools.html?only=pdf,img,av` (toolboxes; put any portrait at `tests/person.jpg` for the cutout test), `tests/smoke.html` (every tool mounts), `tests/width.html` (no sideways scroll on phones), `tests/editor.html` (PDF editor)

## Add a tool
Add a mode to one of the toolbox modules (or a new module exporting `mount(panel, mode)`), then one line in `TOOLS` in `js/catalog.js`.

## Payments
Set `PAY.checkoutUrl` in `js/config.js` to the Stripe Payment Link. Purchase verification (crediting packs securely) is the next step.
