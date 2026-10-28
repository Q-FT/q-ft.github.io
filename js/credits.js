// AI enhancement credits: 10 free per device, then paid packs (20 for $5).
// Free use is counted in this browser. Paid packs are bought through Stripe; see PAY in config.js.
import { PAY } from "./config.js";

const KEY = "qft.credits.v1";
export const FREE = 10;

function load() {
  try { return { freeUsed: 0, paid: 0, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { freeUsed: 0, paid: 0 }; }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

const listeners = new Set();
export const onCreditsChange = (fn) => { listeners.add(fn); fn(state()); };
const emit = () => { const s = state(); listeners.forEach((fn) => fn(s)); };

export function state() {
  const s = load();
  const freeLeft = Math.max(0, FREE - s.freeUsed);
  return { freeLeft, paid: s.paid, total: freeLeft + s.paid };
}

/** Use one credit (free ones first). Returns false when none are left. */
export function spend() {
  const s = load();
  if (s.freeUsed < FREE) s.freeUsed++;
  else if (s.paid > 0) s.paid--;
  else return false;
  save(s); emit(); return true;
}

export function addPaid(n) { const s = load(); s.paid += n; save(s); emit(); }

export function label(s = state()) {
  if (s.paid > 0) return `${s.total} credit${s.total === 1 ? "" : "s"}`;
  return s.freeLeft > 0 ? `${s.freeLeft} free left` : "0 left · buy more";
}

export function openPaywall() {
  const d = document.getElementById("paywall");
  document.getElementById("payNote").textContent = PAY.checkoutUrl ? "Secure checkout by Stripe. Apple Pay and Google Pay accepted." : "Packs are launching very soon. Check back shortly!";
  d.showModal();
}

export function buy() {
  if (!PAY.checkoutUrl) { openPaywall(); return; }
  location.href = PAY.checkoutUrl;
}
