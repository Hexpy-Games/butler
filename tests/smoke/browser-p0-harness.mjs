// Test-only main-process harness. Not copied into Electron release packages.
import { createRequire } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const { app, ipcMain, WebContentsView, webContents, contentTracing } = createRequire(
  new URL("../../packages/butler-app/client/electron/package.json", import.meta.url),
)("electron");

export function installBrowserP0Harness(window) {
  if (process.env.BUTLER_TEST_BROWSER_P0 !== "1" || app.isPackaged) throw new Error("P0 disabled");
  const views = new Map();
  const gone = [];
  const crashes = [];
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
      if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:") throw new Error("Local fixtures only");
      if (views.has(id)) throw new Error("Duplicate tab");
      const gpuOff = !user && process.env.BUTLER_P0_AGENT_GPU === "off";
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, webgl: webgl && !gpuOff, disableBlinkFeatures: gpuOff ? "WebGPU" : "", partition: `p0-${id}` } });
      view.webContents.on("render-process-gone", (_event, details) => crashes.push({ id, code: "tab_crashed", ...details }));
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // Exercise the router cost without product browser policy or API access.
      view.webContents.session.webRequest.onBeforeRequest({ urls: [`${parsed.origin}/*`] }, (_details, callback) => {
        callback({ cancel: false });
      });
      window.contentView.addChildView(view);
      view.setBounds({ x: user ? 900 : 0, y: user ? 0 : ((views.size - 1) % 3) * 180, width: 320, height: 180 });
      views.set(id, view);
      await view.webContents.loadURL(url);
      return view.webContents.id;
    },
    step: id => observeActCapture(get(id)),
    navigate: (id, url) => get(id).loadURL(url),
    evaluate: (id, expression) => get(id).executeJavaScript(expression),
    paintProbe: () => paintProbe(window.webContents),
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
    close(id) {
      const view = views.get(id); if (!view) throw new Error("Unknown tab");
      view.webContents.session.webRequest.onBeforeRequest(null);
      window.contentView.removeChildView(view);
      view.webContents.close(); views.delete(id);
    },
    sample() {
      return { at: performance.now(), versions: process.versions, gpu: app.getGPUFeatureStatus(), gone, crashes,
        mainPID: process.pid, uiPID: window.webContents.getOSProcessId(), mainRSS: process.memoryUsage().rss, metrics: app.getAppMetrics(), initial, resources: baseline(),
        loop: { p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 } };
    },
    gpuPolicy: id => get(id).executeJavaScript("(async()=>({webgl:!!document.createElement('canvas').getContext('webgl')||!!document.createElement('canvas').getContext('webgl2'),webgpu:Boolean(await navigator.gpu?.requestAdapter())}))()"),
    resetDelay: () => delay.reset(),
    traceStart: () => contentTracing.startRecording({ included_categories: ["devtools.timeline", "blink", "gpu", "toplevel", "disabled-by-default-memory-infra", "blink.user_timing"], memory_dump_config: { triggers: [{ mode: "light", periodic_interval_ms: 1000 }] } }),
    traceStop: path => contentTracing.stopRecording(path),
    dispose() {
      for (const id of [...views.keys()]) this.close(id);
      delay.disable(); app.removeListener("child-process-gone", childGone); delete globalThis.browserP0;
    },
  };
}

async function observeActCapture(wc) {
  const observed = await wc.executeJavaScript("({count:document.querySelectorAll('[data-node]').length,ids:Array.from(document.querySelectorAll('[data-node]'),e=>Number(e.dataset.node))})");
  const expected = new URL(wc.getURL()).pathname === "/nodes" ? 10000 : 0;
  if (observed.count !== expected || observed.ids.some((n, i) => n !== i)) throw new Error("Incomplete observation");
  await wc.executeJavaScript("(()=>{const b=document.querySelector('button');if(!b)throw Error('Act target missing');const before=Number(b.dataset.clicks||0);b.click();if(Number(b.dataset.clicks)!==before+1)throw Error('Act failed')})()");
  const start = performance.now();
  const image = await wc.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error("Agent compositor capture empty");
  const capturedMs = performance.now() - start;
  const encodeStart = performance.now();
  const jpeg = image.toJPEG(70);
  return { nodes: observed.count, capturedMs, jpegMs: performance.now() - encodeStart, jpegBytes: jpeg.length };
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
      const x=c.getContext('2d');x.fillStyle='rgb(${expected.slice(0,3).join(",")})';x.fillRect(0,0,1,1);
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
