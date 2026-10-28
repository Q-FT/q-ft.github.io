// Small shared helpers for every tool: file drop zone, downloads, formatting, toast.

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${u[i]}`;
}

export function fmtTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** "1:23.45" or "83.45" -> seconds (NaN if invalid) */
export function parseTime(str) {
  const p = String(str).trim().split(":").map(Number);
  if (p.some((v) => !isFinite(v))) return NaN;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

export const baseName = (name) => name.replace(/\.[^.]+$/, "");
export const extOf = (name) => (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Zip several {name, blob} and download them as one file. */
export async function downloadZip(files, zipName) {
  const { zipSync } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
  const entries = {};
  for (const f of files) {
    let n = f.name, i = 1;
    while (entries[n]) n = `${baseName(f.name)} (${i++}).${extOf(f.name)}`;
    entries[n] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }]; // already-compressed media: store only
  }
  download(new Blob([zipSync(entries)], { type: "application/zip" }), zipName);
}

let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

/** Clickable + droppable area. Calls onFiles(File[]) */
export function dropzone({ accept, multiple = false, title, sub, onFiles }) {
  const el = document.createElement("div");
  el.className = "drop"; el.tabIndex = 0; el.setAttribute("role", "button");
  el.innerHTML = `${ICON_UPLOAD}<b>${esc(title)}</b><span>${esc(sub)}</span>`;
  const input = Object.assign(document.createElement("input"), { type: "file", accept, multiple, hidden: true });
  el.appendChild(input);
  const take = (list) => { const files = [...list].filter(Boolean); if (files.length) onFiles(multiple ? files : files.slice(0, 1)); };
  el.addEventListener("click", () => input.click());
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { take(input.files); input.value = ""; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); take(e.dataTransfer.files); });
  return el;
}

/** Segmented control. Returns { el, get value } */
export function segmented(options, value, onChange) {
  const el = document.createElement("div"); el.className = "seg";
  const ctl = { el, value };
  for (const [v, label] of options) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.classList.toggle("on", v === value);
    b.addEventListener("click", () => { ctl.value = v; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onChange?.(v); });
    el.appendChild(b);
  }
  return ctl;
}

export function opt(label, control) {
  const w = document.createElement("label"); w.className = "opt";
  w.append(label, control instanceof Node ? control : control.el);
  return w;
}

/** One row in a job list: thumbnail, name, meta text, progress bar, action buttons. */
export function jobRow(name, thumbHtml = "") {
  const el = document.createElement("div"); el.className = "job";
  el.innerHTML = `<div class="job__thumb">${thumbHtml}</div><div><div class="job__name">${esc(name)}</div><div class="job__meta"></div><div class="bar"><i></i></div></div><div class="job__act"></div>`;
  return {
    el,
    meta: (html) => { el.querySelector(".job__meta").innerHTML = html; },
    progress: (p) => { const bar = el.querySelector(".bar"); bar.hidden = p == null; if (p != null) bar.firstChild.style.width = `${Math.round(p * 100)}%`; },
    actions: (...btns) => { el.querySelector(".job__act").replaceChildren(...btns); },
    thumb: (node) => { el.querySelector(".job__thumb").replaceChildren(node); },
  };
}

export function button(label, cls = "btn btn--ghost btn--sm", onClick) {
  const b = Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label });
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
