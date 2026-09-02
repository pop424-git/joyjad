// Capture the home screen as a plain viewer (no admin), for comparison with 01-home.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT = __dirname;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9334;
const APP = "http://localhost:5173";

const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + path.join(OUT, "_chromeprofile2"),
  "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb",
  "about:blank"
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function devtools(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch("http://127.0.0.1:" + PORT + p); if (r.ok) return r.json(); } catch (e) {}
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
    const f = path.join(OUT, name + ".jpg");
    fs.writeFileSync(f, Buffer.from(r.data, "base64"));
    console.log(name.padEnd(16) + Math.round(fs.statSync(f).size / 1024) + " KB");
  }
}

(async () => {
  await devtools("/json/version");
  const page = (await devtools("/json/list")).find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  const c = new CDP(ws);

  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1.5, mobile: true });

  let loaded = c.once("Page.loadEventFired");
  await c.send("Page.navigate", { url: APP });
  await loaded;
  await c.evalJS(`localStorage.setItem("badminton-admin-v1","0");
                  localStorage.removeItem("badminton-queue-v3"); true`);
  loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload", {});
  await loaded;
  await sleep(3000);
  await c.shot("00-viewer-home");

  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error("FAILED:", e.message); chrome.kill(); process.exit(1); });
