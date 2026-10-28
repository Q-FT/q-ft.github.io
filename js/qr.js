// QR code generator: links, text, Wi-Fi, email, phone, SMS and contact cards, with colors, dot styles and a logo.
// Rendering by qr-code-styling (MIT). Everything happens in the browser.
import { $, esc, segmented, opt, button, toast } from "./ui.js";

const LIB = "https://cdn.jsdelivr.net/npm/qr-code-styling@1.9.2/lib/qr-code-styling.js";
let libP;
const lib = () => (libP ||= new Promise((res, rej) => {
  const s = Object.assign(document.createElement("script"), { src: LIB, onload: () => res(window.QRCodeStyling), onerror: () => { libP = null; rej(new Error("QR library failed to load")); } });
  document.head.appendChild(s);
}));

// vCard / Wi-Fi need their special characters escaped
const wifiEsc = (s) => s.replace(/([\\;,:"])/g, "\\$1");
const vEsc = (s) => s.replace(/([\\;,])/g, "\\$1").replace(/\n/g, "\\n");

const TYPES = {
  url: { label: "Link", fields: [["url", "Website or link", "https://", "url"]], build: (v) => { const u = v.url.trim(); return u && !/^[a-z]+:/i.test(u) ? `https://${u}` : u; } },
  text: { label: "Text", fields: [["text", "Text", "Anything you want to share", "textarea"]], build: (v) => v.text },
  wifi: { label: "Wi-Fi", fields: [["ssid", "Network name", "MyWiFi"], ["pass", "Password", "", "text"], ["enc", "Security", "WPA", "select:WPA|WEP|nopass"]],
    build: (v) => v.ssid && `WIFI:T:${v.enc === "nopass" ? "nopass" : v.enc};S:${wifiEsc(v.ssid)};${v.enc === "nopass" ? "" : `P:${wifiEsc(v.pass)};`};` },
  email: { label: "Email", fields: [["to", "Email address", "hello@example.com", "email"], ["subject", "Subject", ""], ["body", "Message", "", "textarea"]],
    build: (v) => v.to && `mailto:${v.to}${v.subject || v.body ? "?" + [v.subject && `subject=${encodeURIComponent(v.subject)}`, v.body && `body=${encodeURIComponent(v.body)}`].filter(Boolean).join("&") : ""}` },
  phone: { label: "Phone", fields: [["tel", "Phone number", "+1 555 123 4567", "tel"]], build: (v) => v.tel && `tel:${v.tel.replace(/[^\d+]/g, "")}` },
  sms: { label: "SMS", fields: [["tel", "Phone number", "+1 555 123 4567", "tel"], ["msg", "Message", "", "textarea"]], build: (v) => v.tel && `SMSTO:${v.tel.replace(/[^\d+]/g, "")}:${v.msg}` },
  vcard: { label: "Contact", fields: [["name", "Full name", "Jane Doe"], ["org", "Company", ""], ["tel", "Phone", "", "tel"], ["email", "Email", "", "email"], ["web", "Website", "", "url"]],
    build: (v) => v.name && ["BEGIN:VCARD", "VERSION:3.0", `N:${vEsc(v.name.split(" ").slice(-1)[0])};${vEsc(v.name.split(" ").slice(0, -1).join(" "))};;;`, `FN:${vEsc(v.name)}`, v.org && `ORG:${vEsc(v.org)}`, v.tel && `TEL;TYPE=CELL:${v.tel}`, v.email && `EMAIL:${v.email}`, v.web && `URL:${v.web}`, "END:VCARD"].filter(Boolean).join("\n") },
};

const DOTS = [["square", "Square"], ["rounded", "Rounded"], ["dots", "Dots"], ["classy-rounded", "Classy"]];

export function mount(panel) {
  let type = "url", dots = "rounded", fg = "#111827", fg2 = "#4f46e5", bg = "#ffffff", useGrad = false, logo = null;
  const values = {};
  panel.innerHTML = `<div class="qr"><div class="qr__form"></div><div class="qr__out"><div class="qr__card"><div class="qr__img"></div></div><p class="hint" data-hint></p><div class="row-end" data-dl></div></div></div>`;
  const form = $(".qr__form", panel), box = $(".qr__img", panel), hint = $("[data-hint]", panel);

  const typeSeg = segmented(Object.entries(TYPES).map(([k, t]) => [k, t.label]), type, (v) => { type = v; fields(); render(); });
  typeSeg.el.classList.add("seg--wrap");
  const fieldBox = document.createElement("div"); fieldBox.className = "fields";
  const style = document.createElement("div"); style.className = "opts";
  const color = (val, on) => { const i = Object.assign(document.createElement("input"), { type: "color", value: val }); i.addEventListener("input", () => { on(i.value); render(); }); return i; };
  const gradBox = Object.assign(document.createElement("label"), { className: "check", innerHTML: '<input type="checkbox" /> Gradient' });
  gradBox.firstChild.addEventListener("change", (e) => { useGrad = e.target.checked; c2.hidden = !useGrad; render(); });
  const c2 = color(fg2, (v) => (fg2 = v)); c2.hidden = true;
  const colors = document.createElement("span"); colors.className = "swatches"; colors.append(color(fg, (v) => (fg = v)), c2, gradBox);
  const logoIn = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", hidden: true });
  const logoBtn = button("Add a logo", "btn btn--ghost btn--sm", () => logoIn.click());
  const logoClear = button("Remove", "btn btn--ghost btn--sm", () => { logo = null; logoClear.hidden = true; render(); }); logoClear.hidden = true;
  logoIn.addEventListener("change", () => { const f = logoIn.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { logo = r.result; logoClear.hidden = false; render(); }; r.readAsDataURL(f); logoIn.value = ""; });
  const logoRow = document.createElement("span"); logoRow.className = "swatches"; logoRow.append(logoBtn, logoClear, logoIn);
  style.append(opt("Style", segmented(DOTS, dots, (v) => { dots = v; render(); })), opt("Color", colors), opt("Background", color(bg, (v) => (bg = v))), opt("Center logo", logoRow));
  form.append(opt("Type", typeSeg), fieldBox, style);

  function fields() {
    fieldBox.innerHTML = TYPES[type].fields.map(([k, label, ph, kind = "text"]) => {
      const v = esc(values[`${type}.${k}`] ?? "");
      if (kind === "textarea") return `<label class="opt">${label}<textarea data-k="${k}" rows="3" placeholder="${esc(ph)}">${v}</textarea></label>`;
      if (kind.startsWith("select:")) return `<label class="opt">${label}<select data-k="${k}">${kind.slice(7).split("|").map((o) => `<option ${o === (values[`${type}.${k}`] || ph) ? "selected" : ""} value="${o}">${o === "nopass" ? "None" : o}</option>`).join("")}</select></label>`;
      return `<label class="opt">${label}<input data-k="${k}" type="${kind}" placeholder="${esc(ph)}" value="${v}" /></label>`;
    }).join("");
    fieldBox.querySelectorAll("[data-k]").forEach((el) => el.addEventListener("input", () => { values[`${type}.${el.dataset.k}`] = el.value; render(); }));
  }
  const data = () => { const v = {}; for (const [k, , ph, kind] of TYPES[type].fields) v[k] = values[`${type}.${k}`] ?? (kind?.startsWith("select:") ? ph : ""); return TYPES[type].build(v) || ""; };

  let qr = null, timer = null;
  const opts = () => {
    const text = data() || "https://q-ft.github.io";
    const paint = useGrad ? { gradient: { type: "linear", rotation: Math.PI / 4, colorStops: [{ offset: 0, color: fg }, { offset: 1, color: fg2 }] } } : { color: fg };
    return {
      width: 1024, height: 1024, type: "canvas", data: text, margin: 40, image: logo || undefined,
      qrOptions: { errorCorrectionLevel: logo ? "H" : "Q" },
      dotsOptions: { type: dots, ...paint }, backgroundOptions: { color: bg },
      cornersSquareOptions: { type: dots === "square" ? "square" : "extra-rounded", ...paint }, cornersDotOptions: { type: dots === "square" ? "square" : "dot", ...paint },
      imageOptions: { margin: 12, imageSize: 0.32, hideBackgroundDots: true, crossOrigin: "anonymous" },
    };
  };
  function render() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const QR = await lib().catch((e) => { toast(e.message); return null; }); if (!QR) return;
      const o = opts();
      if (!qr) { qr = new QR(o); box.replaceChildren(); qr.append(box); } else qr.update(o);
      const d = data();
      hint.textContent = !d ? "Fill in the details to make your QR code." : `${d.length} characters${d.length > 300 ? " · long content makes a denser code: print it bigger" : ""}. Test it with your phone camera before printing.`;
      contrastWarn();
    }, 120);
  }
  function contrastWarn() {
    const lum = (h) => { const n = parseInt(h.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const r = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    if (r < 3 || lum(fg) > lum(bg)) hint.textContent = "Careful: dark dots on a light background scan best. Some phones can't read this color combination.";
  }
  const name = () => `qr-${type}`;
  $("[data-dl]", panel).append(
    button("Download SVG", "btn btn--ghost", () => qr?.download({ name: name(), extension: "svg" })),
    button("Download PNG", "btn btn--primary", () => qr?.download({ name: name(), extension: "png" })),
  );
  fields(); render();
}
