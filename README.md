# Q-FT · Quick File Tools

File tools that run entirely in the browser (nothing is uploaded), hosted free on GitHub Pages.

| Tool | How it works |
|---|---|
| AI Photo Enhancer | Real-ESRGAN `realesr-general-x4v3` (BSD-3) exported to ONNX (`models/`), run with ONNX Runtime Web: WebGPU when available, WebAssembly otherwise. Tiled, 2× or 4×. 10 free per device, then paid packs. |
| Compress PDF | pdf-lib + pako: recompresses embedded images, deflates raw streams, repacks with object streams. Text stays vector. |
| Compress & Convert | Canvas re-encode to JPG / WebP / PNG, resize, bulk, zip download (fflate). |
| Trim Audio / Video | ffmpeg.wasm (`vendor/ffmpeg`, core from jsDelivr). Fast = stream copy, Precise = x264 re-encode, plus GIF, MP3, mute, fades. |
| QR Code Generator | qr-code-styling: link, text, Wi-Fi, email, phone, SMS, vCard; colors, gradient, dot styles, logo. |

## Files
- `index.html`, `css/styles.css`, `js/app.js` (routing, cards), `js/ui.js` (shared helpers)
- one module per tool: `js/enhance.js`, `js/pdf.js`, `js/images.js`, `js/media.js`, `js/qr.js`
- `js/credits.js` (free counter + packs), `js/config.js` (Stripe link, pinned CDN versions)
- `tests/run.html` end-to-end checks (`?only=enhance,pdf,images,audio,video,qr`), `tests/width.html` phone overflow check

## Add a tool
Write `js/<tool>.js` exporting `mount(panel, id)`, then add one line to `TOOLS` in `js/app.js`.

## Payments
Set `PAY.checkoutUrl` in `js/config.js` to the Stripe Payment Link. Purchase verification (crediting packs securely) is the next step.
