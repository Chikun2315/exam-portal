/* Shared helpers for all pages */
const Auth = {
  get() { try { return JSON.parse(sessionStorage.getItem("auth") || "null"); } catch { return null; } },
  set(v) { try { sessionStorage.setItem("auth", JSON.stringify(v)); } catch {} },
  clear() { try { sessionStorage.removeItem("auth"); } catch {} },
};

async function api(path, { method = "GET", body } = {}) {
  const a = Auth.get();
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(a ? { authorization: "Bearer " + a.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && a) { Auth.clear(); location.href = "/"; }
  if (!res.ok) {
    const e = new Error(data.error || "Request failed (" + res.status + ")");
    e.status = res.status;
    throw e;
  }
  return data;
}

function requireRole(role) {
  const a = Auth.get();
  if (!a || a.role !== role) { location.replace("/"); throw new Error("redirecting"); }
  return a;
}
function logout() { Auth.clear(); location.href = "/"; }

const $ = (s, r = document) => r.querySelector(s);
const L = (i) => String.fromCharCode(65 + i);
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Server clock: keeps every screen on the server's time, not the device's */
let clockOffset = 0;
function syncClock(serverTime) { clockOffset = serverTime - Date.now(); }
function serverNow() { return Date.now() + clockOffset; }

function fmtClock(ms) {
  const t = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
