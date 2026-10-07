// Browser integration of the real renderer: signal lifecycle, independent of art pixels.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser.ts";

const root = resolve("packages/butler-app/client/ui");
const server = await createServer({ root, configFile: false,
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { "@/butler-ds": `${root}/src/libs/design-system`, "@": `${root}/src` } },
  plugins: [{ name: "paint-harness", configureServer(server) {
    server.middlewares.use("/__paint", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><canvas id="wallpaper" style="width:320px;height:200px"></canvas>');
    });
  } }],
});
await server.listen();
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/__paint`);
  page.on("console", message => console.log(`paint: ${message.text()}`));
  const result = await page.evaluate(async () => {
    const base = "/src/libs/design-system/blocks/Wallpaper/";
    const { createWallpaperEngine } = await import(/* @vite-ignore */ `${base}engine.ts`);
    const { BUILTIN_WALLPAPERS, resolveWallpaperScene } = await import(/* @vite-ignore */ `${base}registry.ts`);
    const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
    const errors: string[] = [];
    const engine = createWallpaperEngine(canvas, { onError: (error: { reason: string }) => errors.push(error.reason) });
    if (!engine) throw new Error("WebGL2 unavailable");
    const states: Record<string, string | undefined>[] = [];
    const frame = async () => {
      for (let i = 0; i < 120; i++) {
        if (canvas.dataset.wallpaperState === "painted") return;
        await new Promise(requestAnimationFrame);
      }
      throw new Error("First frame not painted");
    };
    engine.setMotion("paused", false);
    for (const module of ["butler.bloom", "butler.silk", "butler.shoreline"]) for (const tone of ["light", "dark"]) {
      engine.setScene(resolveWallpaperScene({ kind: "live", module }, BUILTIN_WALLPAPERS, tone));
      if (canvas.dataset.wallpaperState !== "pending") throw new Error("Stale frame readiness");
      await frame();
      if (canvas.dataset.paintedModule !== module || canvas.dataset.paintedTone !== tone) throw new Error("Wrong painted scene");
      states.push({ ...canvas.dataset });
      console.log(`${module} ${tone}: painted`);
      const marks = performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("butler:wallpaper:first-frame:"));
      if (marks.length !== 1 || (marks[0] as PerformanceMark).detail.module !== module) throw new Error("Missing/bounded mark");
      const time = marks[0].startTime;
      let mutations = 0;
      const observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(canvas, { attributes: true });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      observer.disconnect();
      if (mutations) throw new Error("Idle canvas attributes changed");
      if (performance.getEntriesByName(marks[0].name)[0].startTime !== time) throw new Error("Idle mark changed");
    }
    const gl = canvas.getContext("webgl2")!;
    const extension = gl.getExtension("WEBGL_lose_context")!;
    const event = (name: string) => new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} not emitted`)), 5_000);
      canvas.addEventListener(name, () => { clearTimeout(timer); done(); }, { once: true });
    });
    const lost = event("webglcontextlost");
    extension.loseContext();
    await lost;
    if (canvas.dataset.wallpaperState !== "context-lost") throw new Error("Lost context still ready");
    // Finish dispatch of the cancelable loss event before requesting restore.
    await new Promise(requestAnimationFrame);
    const restored = event("webglcontextrestored");
    extension.restoreContext();
    await restored;
    await frame();
    engine.setScene(null);
    if (canvas.getAttribute("data-wallpaper-state") !== "none" || canvas.dataset.paintedModule) throw new Error("None still ready");
    engine.dispose();
    if (canvas.getAttribute("data-wallpaper-state") !== "disposed") throw new Error("Disposed still ready");
    return { states, errors, marks: performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("butler:wallpaper:first-frame:")).length };
  });
  assert.equal(result.states.length, 6);
  assert.deepEqual(result.errors, ["context-lost"]);
  assert.equal(result.marks, 0);
  console.log(JSON.stringify({ ok: true, scenes: result.states.length, retainedMarks: result.marks, idleWrites: 0 }));
} finally { await browser.close(); await server.close(); }
