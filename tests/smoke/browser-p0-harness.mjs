// Test-only main-process harness. Not copied into Electron release packages.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const { app, ipcMain, WebContentsView, webContents, contentTracing } = createRequire(
  new URL("../../packages/butler-app/client/electron/package.json", import.meta.url),
)("electron");

export function installBrowserP0Harness(window, userBrowser) {
  if (process.env.BUTLER_TEST_BROWSER_P0 !== "1" || app.isPackaged) throw new Error("P0 disabled");
  const views = new Map();
  const partitions = new Map();
  let sessionsCreated = 0;
  const sessionCreated = () => { sessionsCreated++; };
  app.on("session-created", sessionCreated);
  const gone = [];
  const crashes = [];
  const routed = { frames: 0, subresources: 0 };
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const childGone = (_event, details) => gone.push({ ...details, at: performance.now() });
  app.on("child-process-gone", childGone);
  const baseline = resourceInventory;
  const initial = baseline();
  const get = id => { const view = views.get(id); if (!view) throw new Error("Unknown tab"); return view.webContents; };
  globalThis.browserP0 = {
    async open(id, url, { webgl = true, user = false } = {}) {
      const parsed = new URL(url);
      if (!((parsed.hostname === "127.0.0.1" && parsed.protocol === "http:") ||
        (parsed.protocol === "https:" && parsed.hostname === "www.iana.org" && ["/help/example-domains", "/domains/reserved"].includes(parsed.pathname)))) throw new Error("P0 fixtures only");
      if (views.has(id)) throw new Error("Duplicate tab");
      // WebGPUService is a candidate, not a proven per-tab block: gpuPolicy must verify it.
      const gpuOff = !user && process.env.BUTLER_P0_AGENT_GPU === "off";
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, webgl: webgl && !gpuOff, additionalArguments: gpuOff ? ["--disable-features=WebGPUService"] : [], partition: process.env.BUTLER_P0_DIAGNOSE_PER_TAB === "1" ? `p0-${id}` : user ? "p0-user" : "p0-agent" } });
      view.webContents.on("render-process-gone", (_event, details) => crashes.push({ id, code: "tab_crashed", ...details }));
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // Sessions live until Electron exits: scope to the two owners, not tab IDs.
      const profile = view.webContents.session;
      if (!partitions.has(profile)) profile.webRequest.onBeforeRequest({ urls: ["http://127.0.0.1/*", "https://www.iana.org/*"] }, (details, callback) => {
        if (!["mainFrame", "subFrame"].includes(details.resourceType)) {
          routed.subresources++; callback({ cancel: false }); return;
        }
        routed.frames++;
        callback({ cancel: false });
      });
      partitions.set(profile, (partitions.get(profile) || 0) + 1);
      window.contentView.addChildView(view);
      view.setBounds({ x: user ? 900 : 0, y: user ? 0 : (Math.max(0, views.size - 1) % 3) * 180, width: 320, height: 180 });
      views.set(id, view);
      await view.webContents.loadURL(url);
      return view.webContents.id;
    },
    step: id => observeActCapture(get(id)),
    productStep: id => observeActCapture(userBrowser.tabs.get(id).view.webContents),
    productInventory: () => ({ tabs: userBrowser.tabs.size, profiles: userBrowser.profiles.size, stillBytes: [...userBrowser.tabs.values()].reduce((n, t) => n + t.still.length, 0) }),
    navigate: (id, url) => get(id).loadURL(url),
    evaluate: (id, expression) => get(id).executeJavaScript(expression),
    paintProbe: () => paintProbe(window.webContents),
    wallpaperFrame: () => wallpaperFrame(window.webContents),
    async beginTyping() {
      const wc = window.webContents;
      window.focus(); wc.focus();
      await wc.executeJavaScript("document.querySelector('[contenteditable=\"true\"]').focus()");
      if (wc.debugger.isAttached()) throw new Error("Unexpected App debugger session");
      wc.debugger.attach("1.3");
    },
    endTyping: () => window.webContents.debugger.detach(),
    insertTextPaint: text => inputCapture(window.webContents, text),
    crashRenderer: id => get(id).forcefullyCrashRenderer(),
    loseGPU(id) { void get(id).loadURL("chrome://gpucrash").catch(() => {}); return true; },
    async close(id) {
      const view = views.get(id); if (!view) throw new Error("Unknown tab");
      const profile = view.webContents.session, remaining = partitions.get(profile) - 1;
      if (remaining) partitions.set(profile, remaining);
      else { profile.webRequest.onBeforeRequest(null); partitions.delete(profile); }
      window.contentView.removeChildView(view);
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
      const destroyed = new Promise(resolve => view.webContents.once("destroyed", resolve));
      view.webContents.close(); views.delete(id); await destroyed;
    },
    sample() {
      return { at: performance.now(), versions: process.versions, gpu: app.getGPUFeatureStatus(), gone, crashes,
        crashLimitDisabled: app.commandLine.hasSwitch("disable-gpu-process-crash-limit"), paths: { userData: app.getPath("userData"), sessionData: app.getPath("sessionData") }, routed, mainPID: process.pid, uiPID: window.webContents.getOSProcessId(), mainRSS: process.memoryUsage().rss, sessionsCreated, metrics: app.getAppMetrics(), initial, resources: baseline(),
        loop: { p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 } };
    },
    gpuPolicy: id => get(id).executeJavaScript("(async()=>({webgl:!!document.createElement('canvas').getContext('webgl'),webgl2:!!document.createElement('canvas').getContext('webgl2'),gpuPresent:!!navigator.gpu,webgpu:Boolean(await navigator.gpu?.requestAdapter())}))()"),
    resetDelay: () => delay.reset(),
    traceStart: () => contentTracing.startRecording({ included_categories: ["devtools", "devtools.timeline", "blink", "gpu", "toplevel", "disabled-by-default-memory-infra", "blink.user_timing"], memory_dump_config: { triggers: [{ mode: "light", periodic_interval_ms: 1000 }] } }),
    traceStop: path => contentTracing.stopRecording(path),
    async dispose() {
      await Promise.all([...views.keys()].map(id => this.close(id)));
      delay.disable(); app.removeListener("session-created", sessionCreated); app.removeListener("child-process-gone", childGone); delete globalThis.browserP0;
    },
  };
}

async function observeActCapture(wc) {
  const observed = await wc.executeJavaScript("({count:document.querySelectorAll('[data-node]').length,ids:Array.from(document.querySelectorAll('[data-node]'),e=>Number(e.dataset.node))})");
  const expected = new URL(wc.getURL()).pathname === "/nodes" ? 10000 : 0;
  if (observed.count !== expected || observed.ids.some((n, i) => n !== i)) throw new Error("Incomplete observation");
  if (new URL(wc.getURL()).protocol === "https:") {
    const heading = new URL(wc.getURL()).pathname === "/help/example-domains" ? "Example Domains" : "IANA-managed Reserved Domains";
    await wc.executeJavaScript(`(()=>{if(document.querySelector('h1')?.textContent.trim()!==${JSON.stringify(heading)})throw Error('Real site incomplete');window.scrollTo(0,document.body.scrollHeight)})()`);
  }
  else await wc.executeJavaScript("(()=>{const b=document.querySelector('button');if(!b)throw Error('Act target missing');const before=Number(b.dataset.clicks||0);b.click();if(Number(b.dataset.clicks)!==before+1||b.textContent!=='Act '+(before+1))throw Error('Act failed')})()");
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  const start = performance.now();
  // ScreencastFrameCaptured posts JPEG encoding to Chromium ThreadPool.
  const expectedSize = await wc.executeJavaScript("({width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio)})");
  const { data } = await captureJpeg(wc, expectedSize);
  const jpeg = Buffer.from(data, "base64");
  if (jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) throw new Error("Incomplete Chromium JPEG");
  const size = jpegSize(jpeg);
  if (size.width !== expectedSize.width || size.height !== expectedSize.height) throw new Error(`Capture resolution mismatch: ${JSON.stringify({ size, expectedSize })}`);
  return { size, nodes: observed.count, capturedMs: performance.now() - start, jpegMs: performance.now() - start, jpegBytes: jpeg.length };

}

async function inputCapture(wc, text) {
  const latencies = [];
  for (const preedit of ["ㅎ", "하", "한", null]) {
    const start = performance.now();
    if (preedit === null) await wc.debugger.sendCommand("Input.insertText", { text });
    else await wc.debugger.sendCommand("Input.imeSetComposition", { text: preedit, selectionStart: preedit.length, selectionEnd: preedit.length });
    await wc.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const image = await wc.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) throw new Error("Empty compositor capture");
    latencies.push(performance.now() - start);
  }
  return latencies;
}

async function paintProbe(wc) {
  const start = performance.now();
  const expected = await wc.executeJavaScript("window.p0PaintNumber=Number(window.p0PaintNumber||0)+1;window.p0PaintNumber%2?[255,255,255,255]:[0,0,0,255]");
  let pixel = [];
  do {
    // A GPU reset can lose the probe's own canvas context. A fresh context
    // checks App recovery rather than retaining that deliberately lost resource.
    await wc.executeJavaScript(`new Promise(resolve=>{
      document.getElementById('p0-paint-probe')?.remove();const c=document.createElement('canvas');c.id='p0-paint-probe';c.width=c.height=1;
      Object.assign(c.style,{position:'fixed',left:'500px',top:'100px',width:'1px',height:'1px',zIndex:'2147483647',pointerEvents:'none'});document.body.append(c);
      const x=c.getContext('2d');x.fillStyle='rgb(${expected.slice(0, 3).join(",")})';x.fillRect(0,0,1,1);
      requestAnimationFrame(()=>requestAnimationFrame(resolve));})`);
    const image = await wc.capturePage({ x: 500, y: 100, width: 1, height: 1 }, { stayHidden: true });
    pixel = [...image.toBitmap().subarray(0, 4)];
    if (pixel.length === 4 && pixel.every((n, i) => n === expected[i])) return performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (performance.now() - start < 2000);
  throw new Error(`Paint probe deadline expired after ${performance.now() - start} ms: ${pixel} expected ${expected}`);
}

function resourceInventory() {
  const contents = webContents.getAllWebContents();
  const emitters = new Set([app, ipcMain, ...contents, ...contents.map(w => w.session)]);
  const listeners = [...emitters].reduce((n, emitter) => n + emitter.eventNames().reduce((count, name) => count + emitter.listenerCount(name), 0), 0);
  return { contents: contents.length, listeners, debuggers: contents.filter(w => w.debugger.isAttached()).length };
}

async function wallpaperFrame(wc) {
  // This region is outside agent/user views and contains the live wallpaper
  // behind the static new-chat content. Hash compositor pixels, not draw calls.
  const image = await wc.capturePage({ x: 600, y: 400, width: 64, height: 64 }, { stayHidden: true });
  if (image.isEmpty()) throw new Error("Wallpaper compositor capture empty");
  return createHash("sha256").update(image.toBitmap()).digest("hex");
}

async function captureJpeg(wc, size) {
  let receive, fail, requestedAt = Infinity;
  const next = new Promise((resolve, reject) => { receive = resolve; fail = reject; });
  const message = (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    if (!Number.isFinite(params.metadata?.timestamp)) { fail(new Error("Capture timestamp unavailable")); return; }
    if (params.metadata.timestamp < requestedAt) {
      void wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(fail); return;
    }
    receive(params);
  };
  const timer = setTimeout(() => fail(new Error("Screencast capture deadline expired")), 10_000);
  wc.debugger.on("message", message);
  try {
    await wc.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    requestedAt = Date.now() / 1000;
    await wc.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1, maxWidth: size.width, maxHeight: size.height });
    const frame = await next;
    await wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId: frame.sessionId });
    return frame;
  } finally {
    clearTimeout(timer); wc.debugger.removeListener("message", message);
    await wc.debugger.sendCommand("Page.stopScreencast");
  }
}

function jpegSize(bytes) {
  for (let offset = 2; offset + 9 < bytes.length;) {
    const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    if (length < 2 || marker === 0xda) break;
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions unavailable");
}
