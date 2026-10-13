// Test-only experiment, installed through the real App main inspector.
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
const { app, BrowserWindow, ipcMain } = createRequire(new URL("../../packages/butler-app/client/electron/package.json", import.meta.url))("electron");

export async function installLiveSpike(browser, origin) {
  const consumer = new BrowserWindow({ show: true, width: 440, height: 840,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./browser-live-consumer.cjs", import.meta.url)) } });
  await consumer.loadURL("data:text/html,<body style='margin:0;background:white'></body>");
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    const result = await browser.execute({ op: "tab.open", session: "live_spike", args: {
      url: `${origin}/__o/busy`, background: true, policy: { content_origin: origin } } });
    if (result.status !== "ok") throw new Error(`Agent open failed: ${result.status}`);
    const tab = browser.tabs.get(result.tab); tabs.push(tab);
    await tab.view.webContents.executeJavaScript("document.readyState");
    await tab.debuggerReady;
    await tab.view.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
  }
  let stats = fresh(), streams = [], polling = null, pollActive = false, generation = 0, paused = false;
  const drawn = (event, value) => {
    if (event.sender === consumer.webContents && value.generation === generation) {
      stats.drawn[value.tab] = (stats.drawn[value.tab] ?? 0) + 1; stats.latencies.push(value.latency);
    }
  };
  ipcMain.on("spike:drawn", drawn);
  const send = (tab, bytes) => {
    if (paused) return;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("Incomplete JPEG");
    stats.frames[tab.id] = (stats.frames[tab.id] ?? 0) + 1;
    stats.bytes += bytes.length; stats.maxFrameBytes = Math.max(stats.maxFrameBytes, bytes.length);
    consumer.webContents.send("spike:frame", { tab: tab.id, bytes, generation });
  };
  return {
    reset() { generation++; stats = fresh(); paused = false; },
    async drain() {
      paused = true;
      const end = Date.now() + 2000;
      while (Date.now() < end && Object.entries(stats.frames).some(([id, count]) => stats.drawn[id] !== count)) await new Promise(r => setTimeout(r, 10));
      if (Object.entries(stats.frames).some(([id, count]) => stats.drawn[id] !== count)) throw new Error("Consumer did not draw every frame");
    },
    facts() { return { hidden: !browser.agentWindow.isVisible(), tabs: tabs.map(t => ({ id: t.id,
      attachedToHidden: t.attached === browser.agentWindow, viewed: t.viewed, userViewed: Boolean(t.userViewed),
      painting: t.view.webContents.isBeingCaptured(), capturerApi: typeof t.view.webContents.incrementCapturerCount })), versions: process.versions }; },
    sample() { return { stats, rss: process.memoryUsage().rss, metrics: app.getAppMetrics() }; },
    async busy(value) { await Promise.all(tabs.map(t => t.view.webContents.executeJavaScript(`window.setBusy(${value})`))); },
    async subscribe() {
      for (const tab of tabs) {
        const wc = tab.view.webContents;
        await tab.debuggerReady;
        // Electron 44 does not expose incrementCapturerCount to JS. Chromium's
        // existing focus-emulation command owns a capturer-count reference.
        await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        const stream = { wc, nextAck: 0, active: true };
        stream.listener = (_event, method, value, session) => {
          if (method !== "Page.screencastFrame" || session) return;
          const start = performance.now();
          send(tab, Buffer.from(value.data, "base64"));
          stats.handlerMs.push(performance.now() - start);
          // Delayed acknowledgements are the experiment: do not discard frames.
          const at = Math.max(performance.now(), stream.nextAck); stream.nextAck = at + 500;
          const timer = setTimeout(() => {
            stream.timers.delete(timer);
            if (stream.active) void wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId: value.sessionId });
          }, at - performance.now());
          stream.timers.add(timer);
        };
        stream.timers = new Set(); streams.push(stream);
        wc.debugger.on("message", stream.listener);
        await wc.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 416, maxHeight: 260 });
      }
    },
    async stop() {
      pollActive = false; clearTimeout(polling); polling = null;
      for (const stream of streams) {
        stream.active = false; for (const timer of stream.timers) clearTimeout(timer);
        await stream.wc.debugger.sendCommand("Page.stopScreencast");
        stream.wc.debugger.removeListener("message", stream.listener);
        await stream.wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
      }
      streams = [];
    },
    fallback() {
      pollActive = true;
      const tick = async () => {
        for (const tab of tabs) {
          const wc = tab.view.webContents;
          await wc.executeJavaScript("document.querySelector('button').click()");
          const start = performance.now(), cpu = process.cpuUsage();
          const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
          if (image.isEmpty()) throw new Error("Empty fallback capture");
          const bytes = image.resize({ width: 416, height: 260 }).toJPEG(60);
          send(tab, bytes);
          stats.captureMs.push(performance.now() - start);
          const used = process.cpuUsage(cpu); stats.captureCpuMs.push((used.user + used.system) / 1000);
        }
        if (pollActive) polling = setTimeout(() => void tick().catch(e => { stats.errors.push(String(e)); }), 2000);
      };
      polling = setTimeout(() => void tick().catch(e => { stats.errors.push(String(e)); }), 0);
    },
    async screenshot(path) { const image = await consumer.webContents.capturePage(); createRequire(import.meta.url)("node:fs").writeFileSync(path, image.toPNG()); },
    async dispose() { await this.stop(); ipcMain.removeListener("spike:drawn", drawn); consumer.destroy(); for (const t of tabs) browser.close(t.id); },
  };
}
function fresh() { return { frames: {}, drawn: {}, bytes: 0, maxFrameBytes: 0, handlerMs: [], latencies: [], captureMs: [], captureCpuMs: [], errors: [] }; }
