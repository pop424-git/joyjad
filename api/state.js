// Live game-state snapshot backed by Vercel KV / Upstash Redis.
// The admin device pushes the whole snapshot; viewer devices poll it read-only.
// Stored with a 24h TTL so a finished/abandoned session disappears on its own.

const KEY = "badminton:state";
const ONLINE_KEY = "badminton:online";
const MAX_BYTES = 40000;
const SESSION_MAX_MS = 300 * 60 * 1000;   // ก๊วนเกิน 5 ชม. = ลืมปิด ทิ้งเอง
const TTL_SECONDS = Math.ceil(SESSION_MAX_MS / 1000);
const ONLINE_WINDOW_MS = 30000;   // ไม่ heartbeat เกินนี้ = ถือว่าปิดหน้าไปแล้ว

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/+$/, ""), token: String(token) };
}

// POST-body command form so a multi-KB value never rides in the URL path.
async function redis(c, command) {
  const r = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}`);
  const j = await r.json();
  return j.result;
}

async function pipeline(c, commands) {
  const r = await fetch(`${c.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}`);
  return r.json();
}

// Sorted set of client ids scored by last-seen ms. Stale ids are trimmed on every read.
async function touchPresence(c, id) {
  const now = Date.now();
  const cmds = [["ZREMRANGEBYSCORE", ONLINE_KEY, 0, now - ONLINE_WINDOW_MS]];
  if (id) cmds.push(["ZADD", ONLINE_KEY, now, id]);
  cmds.push(["ZCARD", ONLINE_KEY], ["EXPIRE", ONLINE_KEY, 300]);
  const out = await pipeline(c, cmds);
  const card = out[id ? 2 : 1];
  const n = card && typeof card.result !== "undefined" ? Number(card.result) : 0;
  return isFinite(n) ? n : 0;
}

function cleanId(raw) {
  const s = String(raw == null ? "" : raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return s || null;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return req.body;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const c = creds();
  if (!c) {
    res.status(503).json({ ok: false, reason: "not-configured" });
    return;
  }

  try {
    if (req.method === "GET") {
      const id = cleanId(req.query && req.query.id);
      const [raw, online] = await Promise.all([
        redis(c, ["GET", KEY]),
        touchPresence(c, id).catch(() => 0),
      ]);
      let state = null;
      if (raw) { try { state = JSON.parse(raw); } catch (e) { state = null; } }
      // อายุก๊วนวัดจากตอนกดเริ่ม ไม่ใช่ savedAt (savedAt เด้งใหม่ทุกครั้งที่แอดมินเซฟ)
      const startedAt = state && (state.sessionStartedAt || state.savedAt);
      if (startedAt && Date.now() - startedAt > SESSION_MAX_MS) {
        state = null;
        redis(c, ["DEL", KEY]).catch(() => {});
      }
      res.status(200).json({ ok: true, state, online });
      return;
    }

    if (req.method === "POST") {
      const body = readBody(req);

      if (body.action === "clear") {
        await redis(c, ["DEL", KEY]);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.action === "set" && body.state && typeof body.state === "object") {
        const str = JSON.stringify(body.state);
        if (str.length > MAX_BYTES) { res.status(413).json({ ok: false, reason: "too-large" }); return; }
        await redis(c, ["SET", KEY, str, "EX", TTL_SECONDS]);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ ok: false, reason: "bad-action" });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ ok: false, reason: "method" });
  } catch (err) {
    res.status(502).json({ ok: false, reason: "upstream", detail: String(err.message || err) });
  }
};
