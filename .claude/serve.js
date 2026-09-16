// Minimal static server for local testing (needs a real origin for localStorage).
// Also mocks /api/roster in memory so the shared-roster flow can be exercised without Upstash.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const port = Number(process.env.PORT) || 5173;
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript" };

let mockPeople = new Map();   // id -> {id, name, level} — mirrors api/roster.js
const LEVELS = ["RK", "BG-", "BG+", "NB", "N", "S"];
const LEVEL_ALIAS = { Rookie: "RK", BG1: "BG-", BG2: "BG+", BG: "BG-", "S-": "BG+", S: "NB", N: "N", "P-": "S", P: "S", "P+": "S" };
let mockState = null;
let mockPlan = null;
let mockPrevLog = null;   // mirrors PREV_KEY in api/state.js — ก๊วนก่อนหน้าล่าสุด 1 ก๊วน
const mockEnded = new Set();    // sessionStartedAt of ended sessions — mirrors ENDED_PREFIX in api/state.js
let mockSetLagMs = 0;           // /api/_mock?lag=ms delays action:"set" to reproduce a slow push
const mockAdmins = new Map();   // clientId -> last check-in ms; viewers never appear here
const ADMIN_WINDOW_MS = 150000; // mirrors ADMIN_WINDOW_MS in api/state.js
let mockDown = false; // toggle via /api/_mock?down=1 to test offline fallback

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function peopleList() {
  return Array.from(mockPeople.values())
    .map((p) => ({ id: p.id, name: p.name, level: p.level }))
    .sort((a, b) => a.name.localeCompare(b.name, "th"));
}
function findByName(name) {
  for (const p of mockPeople.values()) if (p.name === name) return p;
  return null;
}
function cleanLevel(raw) {
  const lv = String(raw == null ? "" : raw).trim();
  if (!lv || lv === "-") return "";
  if (LEVELS.indexOf(lv) >= 0) return lv;
  return LEVEL_ALIAS[lv] || null;
}
function newMockId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

http.createServer((req, res) => {
  const [rawPath, query] = req.url.split("?");
  const rel = decodeURIComponent(rawPath);

  if (rel === "/api/_mock") {
    const params = new URLSearchParams(query || "");
    if (params.has("down")) mockDown = params.get("down") === "1";
    if (params.has("clear")) { mockPeople = new Map(); mockState = null; mockPlan = null; mockPrevLog = null; mockAdmins.clear(); mockEnded.clear(); }
    if (params.has("lag")) mockSetLagMs = Number(params.get("lag")) || 0;
    if (params.has("expireplan") && mockPlan) mockPlan.expiresAt = Date.now() - 1000;
    if (params.has("stale")) { for (const k of mockAdmins.keys()) mockAdmins.set(k, Date.now() - ADMIN_WINDOW_MS - 1000); }
    if (params.has("seed")) params.get("seed").split(",").filter(Boolean).forEach((n) => {
      if (!findByName(n)) { const id = newMockId(); mockPeople.set(id, { id, name: n, level: "" }); }
    });
    sendJSON(res, 200, { ok: true, down: mockDown, people: peopleList() });
    return;
  }

  if (rel === "/api/state") {
    if (mockDown) { sendJSON(res, 503, { ok: false, reason: "not-configured" }); return; }
    if (req.method === "GET") {
      const params = new URLSearchParams(query || "");
      const id = params.get("id");
      const wantAdmin = params.get("admin") === "1" && !!id;
      const wantPrev = params.get("prevlog") === "1";
      const now = Date.now();
      let online;
      if (wantAdmin) {
        mockAdmins.set(id, now);
        online = 0;
        for (const t of mockAdmins.values()) if (now - t <= ADMIN_WINDOW_MS) online++;
      }
      const startedAt = mockState && (mockState.sessionStartedAt || mockState.savedAt);
      if (startedAt && now - startedAt > 300 * 60 * 1000) mockState = null;
      if (mockPlan && (!mockPlan.expiresAt || now > mockPlan.expiresAt)) mockPlan = null;
      sendJSON(res, 200, { ok: true, state: mockState, online, plan: mockPlan, prevLog: wantPrev ? mockPrevLog : undefined });
      return;
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (e) { /* ignore */ }
        if (body.action === "clear") {
          if (Number(body.session) > 0) mockEnded.add(Math.floor(Number(body.session)));
          mockState = null; sendJSON(res, 200, { ok: true }); return;
        }
        if (body.action === "adminOut") { if (body.id) mockAdmins.delete(String(body.id)); sendJSON(res, 200, { ok: true }); return; }
        if (body.action === "setPrev" && body.prev) { mockPrevLog = body.prev; sendJSON(res, 200, { ok: true }); return; }
        if (body.action === "set" && body.state) {
          // Mirrors api/state.js: ended sessions are refused; the write time comes from the server.
          setTimeout(() => {
            const sid = Math.floor(Number(body.state.sessionStartedAt || body.state.savedAt) || 0);
            if (sid && (Date.now() - sid > 300 * 60 * 1000 || mockEnded.has(sid))) {
              sendJSON(res, 409, { ok: false, reason: "ended" }); return;
            }
            mockState = Object.assign({}, body.state, { srvAt: Date.now() });
            sendJSON(res, 200, { ok: true, srvAt: mockState.srvAt });
          }, mockSetLagMs);
          return;
        }
        if (body.action === "clearPlan") { mockPlan = null; sendJSON(res, 200, { ok: true, plan: null }); return; }
        if (body.action === "setPlan" && body.plan) {
          mockPlan = Object.assign({}, body.plan, { v: 1, updatedAt: Date.now() });
          sendJSON(res, 200, { ok: true, plan: mockPlan });
          return;
        }
        sendJSON(res, 400, { ok: false, reason: "bad-action" });
      });
      return;
    }
    sendJSON(res, 405, { ok: false, reason: "method" });
    return;
  }

  if (rel === "/api/roster") {
    if (mockDown) { sendJSON(res, 503, { ok: false, reason: "not-configured" }); return; }
    if (req.method === "GET") { sendJSON(res, 200, { ok: true, people: peopleList() }); return; }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (e) { /* ignore */ }
        const name = String(body.name || "").trim();
        const id = String(body.id || "").trim();
        const level = cleanLevel(body.level);
        if (level === null) { sendJSON(res, 400, { ok: false, reason: "bad-level" }); return; }
        const target = mockPeople.get(id) || (name ? findByName(name) : null);
        if (body.action === "reset") mockPeople = new Map();
        else if (body.action === "add" && name) {
          const dup = findByName(name);
          if (dup) { if (level && !dup.level) dup.level = level; }
          else mockPeople.set(id || newMockId(), { id: id || newMockId(), name, level });
        }
        else if (body.action === "remove" && target) mockPeople.delete(target.id);
        else if (body.action === "level" && target) target.level = level;
        else if (body.action === "rename" && target) {
          const to = String(body.to || "").trim();
          const clash = findByName(to);
          if (!to) { sendJSON(res, 400, { ok: false, reason: "bad-name" }); return; }
          if (clash && clash.id !== target.id) { sendJSON(res, 409, { ok: false, reason: "name-taken" }); return; }
          target.name = to;
        }
        else if (["add", "remove", "level", "rename", "reset"].indexOf(body.action) < 0) {
          sendJSON(res, 400, { ok: false, reason: "bad-action" }); return;
        }
        sendJSON(res, 200, { ok: true, people: peopleList() });
      });
      return;
    }
    sendJSON(res, 405, { ok: false, reason: "method" });
    return;
  }

  const file = path.join(root, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(root)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(port, () => console.log("serving on http://localhost:" + port));
