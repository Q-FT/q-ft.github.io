// Q-FT shell: home page tool cards, #/tool routing, credits badge.
import { $, esc } from "./ui.js";
import { onCreditsChange, label, openPaywall, buy } from "./credits.js";

import { TOOLS, CATS, icon } from "./catalog.js";

// little landscape used for the animated before/after in the Enhancer card
const SCENE = `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#312e81"/><stop offset=".55" stop-color="#c026d3"/><stop offset="1" stop-color="#fb923c"/></linearGradient><linearGradient id="lk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c2d12"/><stop offset="1" stop-color="#1e1b4b"/></linearGradient></defs>
<rect width="400" height="200" fill="url(#sk)"/><circle cx="270" cy="112" r="34" fill="#fde68a"/><g fill="#fff" opacity=".85"><circle cx="60" cy="30" r="1.2"/><circle cx="120" cy="18" r="1"/><circle cx="330" cy="26" r="1.3"/><circle cx="210" cy="40" r=".9"/></g>
<path d="M0 140 L60 90 L95 118 L150 70 L205 125 L250 100 L300 135 L350 95 L400 128 V200 H0Z" fill="#1e1b4b"/><path d="M150 70 L168 86 L158 84 L150 92 L142 82 L132 86Z M350 95 L364 108 L350 104 L340 110Z" fill="#e0e7ff"/>
<path d="M0 160 L80 130 L140 150 L220 128 L300 152 L400 136 V200 H0Z" fill="#0f0d2e"/><rect y="168" width="400" height="32" fill="url(#lk)"/><g stroke="#fde68a" stroke-width="2" opacity=".7"><path d="M250 174h40M258 181h24M264 188h12"/></g></svg>`;

const sizeOf = (t) => (t.featured === "hero" ? "hero" : t.featured === "wide" ? "wide" : "");
$("#toolGrid").innerHTML = TOOLS.filter((t) => t.featured).map((t) => `
  <a class="tcard${sizeOf(t) ? ` tcard--${sizeOf(t)}` : ""}" href="#/${t.id}" style="--a1:${t.a[0]};--a2:${t.a[1]}">
    ${t.featured === "hero" ? `<div class="demo" aria-hidden="true"><div class="demo__before">${SCENE}</div><div class="demo__after">${SCENE}</div><span class="demo__line"></span><span class="demo__tag" style="left:10px">Before</span><span class="demo__tag" style="right:10px">After</span></div>` : ""}
    <span class="tcard__icon">${icon(t.icon)}</span>${t.pill ? `<span class="pill">${t.pill}</span>` : ""}<span class="go">→</span>
    <div><h3>${esc(t.name)}</h3><p>${esc(t.short)}</p></div></a>`).join("");

// full catalog: category chips + search
let cat = "all", query = "";
$("#cats").innerHTML = CATS.map(([k, l]) => `<button type="button" class="chip${k === cat ? " on" : ""}" data-cat="${k}">${l}<span>${TOOLS.filter((t) => (k === "all" ? !t.soon : k === "soon" ? t.soon : k === "ai" ? t.ai || (t.soon && t.cat === "ai") : t.cat === k && !t.soon)).length}</span></button>`).join("");
function renderAll() {
  const q = query.trim().toLowerCase();
  const list = TOOLS.filter((t) => {
    if (q) return `${t.name} ${t.short}`.toLowerCase().includes(q);
    if (cat === "all") return !t.soon;
    if (cat === "soon") return t.soon;
    if (cat === "ai") return t.ai || (t.soon && t.cat === "ai");
    return t.cat === cat && !t.soon;
  });
  $("#allGrid").innerHTML = list.length ? list.map((t) => `
    <${t.soon ? "div" : "a"} class="mini${t.soon ? " mini--soon" : ""}" ${t.soon ? "" : `href="#/${t.id}"`} style="--a1:${t.a[0]};--a2:${t.a[1]}">
      <span class="mini__icon">${icon(t.icon)}</span><span class="mini__txt"><b>${esc(t.name)}</b><small>${esc(t.short)}</small></span>${t.soon ? '<span class="soon">Soon</span>' : ""}
    </${t.soon ? "div" : "a"}>`).join("") : `<p class="muted">No tool matches "${esc(query)}". More tools are on the way.</p>`;
}
$("#cats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (!b) return; cat = b.dataset.cat; query = ""; $("#toolSearch").value = ""; document.querySelectorAll("#cats .chip").forEach((x) => x.classList.toggle("on", x === b)); renderAll(); });
$("#toolSearch").addEventListener("input", (e) => { query = e.target.value; renderAll(); });
renderAll();

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
  const id = (location.hash.match(/^#\/([a-z0-9-]+)/) || [])[1];
  const tool = TOOLS.find((t) => t.id === id && !t.soon);
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
    current = (await mod.mount(panel, tool.mode || tool.id)) || null;
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
