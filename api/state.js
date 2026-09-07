// Live game-state snapshot backed by Vercel KV / Upstash Redis.
// The admin device pushes the whole snapshot; viewer devices poll it read-only.
// Stored with a 24h TTL so a finished/abandoned session disappears on its own.
//
// The same endpoint also carries the session plan ("นัดวันนี้") under a separate
// Redis key, so ending a session clears the game state without wiping the plan.

const KEY = "badminton:state";
const PLAN_KEY = "badminton:plan";
const ONLINE_KEY = "badminton:online";
const MAX_BYTES = 40000;
const SESSION_MAX_MS = 300 * 60 * 1000;   // ก๊วนเกิน 5 ชม. = ลืมปิด ทิ้งเอง
const TTL_SECONDS = Math.ceil(SESSION_MAX_MS / 1000);
const ONLINE_WINDOW_MS = 30000;   // ไม่ heartbeat เกินนี้ = ถือว่าปิดหน้าไปแล้ว
const PLAN_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;   // กัน expiresAt เพี้ยนมาค้างยาว
const PLAN_MAX_COURTS = 4;
const PLAN_TOTAL_COURTS = 10;
const PLAN_MAX_PLAYERS = 60;

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

function text(raw, max) {
  return String(raw == null ? "" : raw).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

// Rebuilt field by field — never store whatever shape the client happened to send.
// expiresAt comes from the client because only it knows the ก๊วน's local timezone;
// it is clamped here so a bad clock can't park a plan for months.
function cleanPlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const start = /^\d{2}:\d{2}$/.test(raw.start) ? raw.start : null;
  const end = /^\d{2}:\d{2}$/.test(raw.end) ? raw.end : null;
  if (!date || !start || !end) return null;

  const seen = {};
  const courts = (Array.isArray(raw.courts) ? raw.courts : [])
    .map((n) => parseInt(n, 10))
    .filter((n) => n >= 1 && n <= PLAN_TOTAL_COURTS && !seen[n] && (seen[n] = true))
    .slice(0, PLAN_MAX_COURTS);
  if (!courts.length) return null;

  const dup = {};
  const players = (Array.isArray(raw.players) ? raw.players : [])
    .map((n) => text(n, 20))
    .filter((n) => n && !dup[n] && (dup[n] = true))
    .slice(0, PLAN_MAX_PLAYERS);

  const now = Date.now();
  let expiresAt = Number(raw.expiresAt);
  if (!isFinite(expiresAt) || expiresAt <= now) expiresAt = now + 24 * 60 * 60 * 1000;
  if (expiresAt > now + PLAN_MAX_AHEAD_MS) expiresAt = now + PLAN_MAX_AHEAD_MS;

  return {
    v: 1,
    venue: text(raw.venue, 40) || "สนามแบด",
    date, start, end, courts, players,
    note: text(raw.note, 120),
    expiresAt,
    updatedAt: now,
  };
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
      const [raw, planRaw, online] = await Promise.all([
        redis(c, ["GET", KEY]),
        redis(c, ["GET", PLAN_KEY]).catch(() => null),
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
      let plan = null;
      if (planRaw) { try { plan = JSON.parse(planRaw); } catch (e) { plan = null; } }
      if (plan && (!plan.expiresAt || Date.now() > plan.expiresAt)) {   // เลยเวลานัดแล้ว
        plan = null;
        redis(c, ["DEL", PLAN_KEY]).catch(() => {});
      }
      res.status(200).json({ ok: true, state, online, plan });
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

      if (body.action === "clearPlan") {
        await redis(c, ["DEL", PLAN_KEY]);
        res.status(200).json({ ok: true, plan: null });
        return;
      }

      if (body.action === "setPlan") {
        const plan = cleanPlan(body.plan);
        if (!plan) { res.status(400).json({ ok: false, reason: "bad-plan" }); return; }
        const ttl = Math.max(60, Math.ceil((plan.expiresAt - Date.now()) / 1000));
        await redis(c, ["SET", PLAN_KEY, JSON.stringify(plan), "EX", ttl]);
        res.status(200).json({ ok: true, plan });
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
