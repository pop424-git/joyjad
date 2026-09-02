// Drive the real app in headless Chrome via CDP and capture JPEG screenshots.
// The app exposes window.__bq (its own test hook) — we use that instead of faking a UI.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT = __dirname;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const APP = "http://localhost:5173";

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + path.join(OUT, "_chromeprofile"),
  "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb",
  "about:blank"
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function devtools(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch("http://127.0.0.1:" + PORT + p); if (r.ok) return r.json(); }
    catch (e) {}
    await sleep(250);
  }
  throw new Error("devtools not reachable");
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = new Map();
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waits.has(m.id)) { const w = this.waits.get(m.id); this.waits.delete(m.id);
        m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
      else if (m.method && this.events.has(m.method)) { const l = this.events.get(m.method); this.events.delete(m.method); l(); }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  once(method) { return new Promise(res => this.events.set(method, res)); }
  async evalJS(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(expression.slice(0, 70) + " -> " + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async shot(name, quality) {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: quality || 82 });
    const f = path.join(OUT, name + ".jpg");
    fs.writeFileSync(f, Buffer.from(r.data, "base64"));
    console.log(name.padEnd(16) + Math.round(fs.statSync(f).size / 1024) + " KB");
  }
}

const NAMES = ["ต้น", "บอย", "แนน", "ฝ้าย", "โอ๊ต", "มิ้นท์", "กอล์ฟ", "ปุ๊ก", "ปอ", "ตูน", "แพร", "หนึ่ง"];
const CLOSE_SHEET = `document.getElementById("sheetWrap").classList.remove("show"); true`;
const PICKED = NAMES.slice(0, 12);

const SEED = `(function(){
  var now = Date.now();
  var names = ${JSON.stringify(NAMES)};
  var games  = [4,3,4,3, 5,4,5,4, 2,2,1,1];
  var consec = [2,2,1,1, 1,1,2,2, 0,0,0,0];
  var players = names.map(function(n,i){
    return { id:i+1, name:n, attending:true, games:games[i], consec:consec[i], order:i+1,
             waitSince: now - (i>=8 ? (13-i)*95000 : 0) };
  });
  var d = { v:3, savedAt:now, sessionStartedAt: now - 52*60000, phase:"play", courtCount:2,
    players: players,
    courts: [ { id:1, no:"1", slots:[1,2,3,4], gameNo:4, startedAt: now - 9*60000 },
              { id:2, no:"2", slots:[5,6,7,8], gameNo:6, startedAt: now - 4*60000 } ],
    turnCounter: 13, cost:{court:0,shuttles:0,tube:0}, callout:null };
  __bq.applySnapshot(d);
  __bq.showScreen("play"); __bq.render();
  return true;
})()`;

(async () => {
  await devtools("/json/version");
  const targets = await devtools("/json/list");
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  const c = new CDP(ws);

  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1.5, mobile: true });

  // boot once as a plain viewer to get an origin, then flip admin on and reload clean
  let loaded = c.once("Page.loadEventFired");
  await c.send("Page.navigate", { url: APP });
  await loaded;
  await c.evalJS(`localStorage.setItem("badminton-admin-v1","1");
                  localStorage.removeItem("badminton-queue-v3"); true`);
  loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload", {});
  await loaded;
  await sleep(1500);

  // remember a roster so the "choose players" screen has names to tap
  await c.evalJS(`__bq.stampRoster(${JSON.stringify(NAMES)}); __bq.render(); true`);
  await sleep(500);

  // 1 — home / first screen
  await c.shot("01-home");

  // 3 — step 2: who showed up today
  await c.evalJS(`__bq.setPicked(${JSON.stringify(PICKED)}); __bq.showScreen("pick"); __bq.render(); true`);
  await sleep(600);
  await c.shot("03-pick");

  // 4 — step 3: put people on court
  await c.evalJS(`__bq.buildFromPicked(); __bq.showScreen("arrange"); __bq.arrangeAuto(); __bq.render(); true`);
  await sleep(600);
  await c.shot("04-arrange");

  // 5 — the main screen during play
  await c.evalJS(SEED);
  await sleep(1000);
  await c.shot("05-play");

  // 6 — pressed "end game": who goes out, who comes in
  await c.evalJS(`__bq.openEndGame(1); true`);
  await sleep(600);
  await c.shot("06-endgame");

  // 7 — confirmed: the real fullscreen call
  await c.evalJS(`__bq.confirmEnd(); true`);
  await sleep(900);
  await c.shot("07-callout");

  // 8 — swapping a player mid-game
  await c.evalJS(`__bq.hideCallout(); true`);
  await sleep(300);
  await c.evalJS(SEED);
  await sleep(700);
  await c.evalJS(`__bq.openSub(2, 1); true`);
  await sleep(600);
  await c.shot("08-sub");

  // 9 — roster sheet: late arrivals / people going home
  await c.evalJS(CLOSE_SHEET);
  await c.evalJS(SEED);
  await sleep(500);
  await c.evalJS(`document.getElementById("btnManage").click(); true`);
  await sleep(600);
  await c.shot("09-manage");

  // 10 — end of session: games played per person
  await c.evalJS(`document.getElementById("manageOverlay").classList.remove("show");
                  __bq.showScreen("summary"); __bq.render(); true`);
  await sleep(700);
  await c.shot("10-summary");

  // 11 — splitting the bill
  await c.evalJS(`__bq.showScreen("cost"); __bq.render(); __bq.setCost({court:800, shuttles:9, tube:390}); true`);
  await sleep(700);
  await c.shot("11-cost");

  // 12 — what everyone else sees: read-only live view
  await c.evalJS(`__bq.applySnapshot(__bq.snapshot()); true`).catch(() => {});
  await c.evalJS(SEED);
  await sleep(1500);                                   // let the admin push land on the server
  await c.evalJS(`localStorage.setItem("badminton-admin-v1","0"); true`);
  loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload", {});
  await loaded;
  await sleep(2500);                                   // viewer polls /api/state
  await c.shot("12-viewer");

  ws.close();
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error("FAILED:", e.message); chrome.kill(); process.exit(1); });
