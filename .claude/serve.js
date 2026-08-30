// Minimal static server for local testing (needs a real origin for localStorage).
// Also mocks /api/roster in memory so the shared-roster flow can be exercised without Upstash.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const port = 5173;
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript" };

let mockRoster = new Set();
let mockState = null;
let mockPlan = null;
const mockOnline = new Map();
let mockDown = false; // toggle via /api/_mock?down=1 to test offline fallback

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sorted() {
  return Array.from(mockRoster).sort((a, b) => a.localeCompare(b, "th"));
}

http.createServer((req, res) => {
  const [rawPath, query] = req.url.split("?");
  const rel = decodeURIComponent(rawPath);

  if (rel === "/api/_mock") {
    const params = new URLSearchParams(query || "");
    if (params.has("down")) mockDown = params.get("down") === "1";
    if (params.has("clear")) { mockRoster = new Set(); mockState = null; mockPlan = null; mockOnline.clear(); }
    if (params.has("expireplan") && mockPlan) mockPlan.expiresAt = Date.now() - 1000;
    if (params.has("stale")) { for (const k of mockOnline.keys()) mockOnline.set(k, Date.now() - 60000); }
    if (params.has("seed")) params.get("seed").split(",").filter(Boolean).forEach((n) => mockRoster.add(n));
    sendJSON(res, 200, { ok: true, down: mockDown, names: sorted() });
    return;
  }

  if (rel === "/api/state") {
    if (mockDown) { sendJSON(res, 503, { ok: false, reason: "not-configured" }); return; }
    if (req.method === "GET") {
      const id = new URLSearchParams(query || "").get("id");
      const now = Date.now();
      for (const [k, t] of mockOnline) if (now - t > 30000) mockOnline.delete(k);
      if (id) mockOnline.set(id, now);
      const startedAt = mockState && (mockState.sessionStartedAt || mockState.savedAt);
      if (startedAt && now - startedAt > 300 * 60 * 1000) mockState = null;
      if (mockPlan && (!mockPlan.expiresAt || now > mockPlan.expiresAt)) mockPlan = null;
      sendJSON(res, 200, { ok: true, state: mockState, online: mockOnline.size, plan: mockPlan });
      return;
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (e) { /* ignore */ }
        if (body.action === "clear") { mockState = null; sendJSON(res, 200, { ok: true }); return; }
        if (body.action === "set" && body.state) { mockState = body.state; sendJSON(res, 200, { ok: true }); return; }
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
    if (req.method === "GET") { sendJSON(res, 200, { ok: true, names: sorted() }); return; }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (e) { /* ignore */ }
        const name = String(body.name || "").trim();
        if (body.action === "reset") mockRoster = new Set();
        else if (body.action === "add" && name) mockRoster.add(name);
        else if (body.action === "remove" && name) mockRoster.delete(name);
        else if (body.action !== "reset") { sendJSON(res, 400, { ok: false, reason: "bad-action" }); return; }
        sendJSON(res, 200, { ok: true, names: sorted() });
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
