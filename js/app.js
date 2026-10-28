// Q-FT shell: home page tool cards, #/tool routing, credits badge.
import { $, esc } from "./ui.js";
import { onCreditsChange, label, openPaywall, buy } from "./credits.js";

const I = {
  spark: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 14l3 3 3-3M12 10v7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
};
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

export const TOOLS = [
  { id: "enhance", icon: I.spark, name: "AI Photo Enhancer", short: "Upscale 2× or 4× and bring back detail. Removes blur, noise and JPEG artifacts.", pill: "10 free", size: "hero", a: ["#8b5cf6", "#22d3ee"], load: () => import("./enhance.js") },
  { id: "pdf", icon: I.pdf, name: "Compress PDF", short: "Small enough to email. Text stays sharp.", a: ["#f43f5e", "#fb923c"], load: () => import("./pdf.js") },
  { id: "images", icon: I.image, name: "Compress & Convert", short: "JPG, WebP, PNG. Resize in bulk.", a: ["#10b981", "#22d3ee"], load: () => import("./images.js") },
  { id: "audio", icon: I.audio, name: "Trim Audio", short: "Cut songs and voice notes. Fade in and out.", a: ["#f59e0b", "#f472b6"], load: () => import("./media.js") },
  { id: "video", icon: I.video, name: "Trim Video", short: "Lossless cuts, mute, GIF or MP3.", a: ["#6366f1", "#ec4899"], load: () => import("./media.js") },
  { id: "qr", icon: I.qr, name: "QR Code Generator", short: "Links, Wi-Fi, contacts and more. Your colors, your logo, print ready.", size: "wide", a: ["#06b6d4", "#8b5cf6"], load: () => import("./qr.js") },
];

// little landscape used for the animated before/after in the Enhancer card
const SCENE = `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#312e81"/><stop offset=".55" stop-color="#c026d3"/><stop offset="1" stop-color="#fb923c"/></linearGradient><linearGradient id="lk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c2d12"/><stop offset="1" stop-color="#1e1b4b"/></linearGradient></defs>
<rect width="400" height="200" fill="url(#sk)"/><circle cx="270" cy="112" r="34" fill="#fde68a"/><g fill="#fff" opacity=".85"><circle cx="60" cy="30" r="1.2"/><circle cx="120" cy="18" r="1"/><circle cx="330" cy="26" r="1.3"/><circle cx="210" cy="40" r=".9"/></g>
<path d="M0 140 L60 90 L95 118 L150 70 L205 125 L250 100 L300 135 L350 95 L400 128 V200 H0Z" fill="#1e1b4b"/><path d="M150 70 L168 86 L158 84 L150 92 L142 82 L132 86Z M350 95 L364 108 L350 104 L340 110Z" fill="#e0e7ff"/>
<path d="M0 160 L80 130 L140 150 L220 128 L300 152 L400 136 V200 H0Z" fill="#0f0d2e"/><rect y="168" width="400" height="32" fill="url(#lk)"/><g stroke="#fde68a" stroke-width="2" opacity=".7"><path d="M250 174h40M258 181h24M264 188h12"/></g></svg>`;

$("#toolGrid").innerHTML = TOOLS.map((t) => `
  <a class="tcard${t.size ? ` tcard--${t.size}` : ""}" href="#/${t.id}" style="--a1:${t.a[0]};--a2:${t.a[1]}">
    ${t.size === "hero" ? `<div class="demo" aria-hidden="true"><div class="demo__before">${SCENE}</div><div class="demo__after">${SCENE}</div><span class="demo__line"></span><span class="demo__tag" style="left:10px">Before</span><span class="demo__tag" style="right:10px">After</span></div>` : ""}
    <span class="tcard__icon">${svg(t.icon)}</span>${t.pill ? `<span class="pill">${t.pill}</span>` : ""}<span class="go">→</span>
    <div><h3>${esc(t.name)}</h3><p>${esc(t.short)}</p></div></a>`).join("");

// card glow follows the pointer; a soft spotlight follows it across the page
document.addEventListener("pointermove", (e) => {
  document.documentElement.style.setProperty("--sx", `${e.clientX}px`); document.documentElement.style.setProperty("--sy", `${e.clientY}px`);
  const c = e.target.closest?.(".tcard"); if (!c) return;
  const r = c.getBoundingClientRect(); c.style.setProperty("--mx", `${e.clientX - r.left}px`); c.style.setProperty("--my", `${e.clientY - r.top}px`);
}, { passive: true });

// rotating verb in the headline
const words = [...document.querySelectorAll("#rot span")]; let w = 0;
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setInterval(() => {
  if (document.hidden) return;
  const cur = words[w]; w = (w + 1) % words.length; const nxt = words[w];
  cur.classList.replace("on", "out"); nxt.classList.remove("out"); nxt.classList.add("on");
  setTimeout(() => cur.classList.remove("out"), 650);
}, 2200);

let current = null;
async function route() {
  const id = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  const tool = TOOLS.find((t) => t.id === id);
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${id}`));
  const view = $("#toolView");
  if (!tool) {
    current?.unmount?.(); current = null;
    view.hidden = true; view.replaceChildren(); $("#home").hidden = false;
    document.title = "Q-FT · Quick File Tools: enhance photos, compress PDFs, trim audio & video";
    if (location.hash.length > 2 && !location.hash.startsWith("#/")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    return;
  }
  $("#home").hidden = true; view.hidden = false;
  document.title = `${tool.name} · Q-FT`;
  current?.unmount?.();
  view.innerHTML = `<div class="wrap"><div class="tool-head"><a class="back" href="#/">← All tools</a></div><div class="panel"><div class="status"><span class="spin"></span>Loading…</div></div></div>`;
  window.scrollTo(0, 0);
  try {
    const mod = await tool.load();
    const host = document.createElement("div"); host.className = "wrap";
    host.innerHTML = `<div class="tool-head"><a class="back" href="#/">← All tools</a><h1>${esc(tool.name)}</h1><p>${esc(tool.short)}</p></div>`;
    const panel = document.createElement("div"); panel.className = "panel"; host.appendChild(panel);
    view.replaceChildren(host);
    current = mod.mount(panel, tool.id) || null;
  } catch (e) {
    console.error(e);
    view.querySelector(".panel").innerHTML = `<p>Sorry, this tool couldn't load. Check your connection and refresh the page.</p>`;
  }
}
addEventListener("hashchange", route);
route();

onCreditsChange((s) => { $("#creditsText").textContent = label(s); });
$("#creditsBadge").addEventListener("click", openPaywall);
document.addEventListener("click", (e) => { if (e.target.closest("[data-buy]")) buy(); });
$("#creditsLink").addEventListener("click", (e) => { e.preventDefault(); $("#ossCredits").hidden = !$("#ossCredits").hidden; });
