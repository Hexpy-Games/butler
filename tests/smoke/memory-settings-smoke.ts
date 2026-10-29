// Product component browser harness, with an offline gateway and no native agent or model calls.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit, type Page } from "playwright";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import react from "../../packages/butler-app/client/ui/node_modules/@vitejs/plugin-react/dist/index.js";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { checkConsolidationControls, checkInstructionGeometry, checkInstructionScroll, checkTimePicker } from "../support/memory-settings-acceptance.ts";

const uiRoot = resolve("packages/butler-app/client/ui");
const entry = "/@fs" + resolve("tests/support/memory-settings-render.tsx");
const dependencies = Object.keys(JSON.parse(readFileSync(resolve(uiRoot, "package.json"), "utf8")).dependencies);
const server = await createServer({ configFile: false, root: uiRoot, cacheDir: resolve(tmpdir(), "butler-memory-settings-vite"),
  server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd()] } },
  optimizeDeps: { entries: [entry.slice(4)], noDiscovery: true, include: [...dependencies.filter(name => /^(react|@dnd-kit|@hugeicons|@radix-ui|class-variance-authority|clsx|recharts|sonner|tailwind-merge|highlight.js|lowlight|remark-gfm)/.test(name)), "react-dom/client", "react/jsx-runtime"] },
  resolve: { alias: { "@/butler-ds": `${uiRoot}/src/libs/design-system`, "@": `${uiRoot}/src` } },
  plugins: [react(), { name: "memory-settings-harness", configureServer(host) {
    host.middlewares.use("/__memory_settings", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await host.transformIndexHtml("/__memory_settings", `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  } }],
});
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const output = process.env.BUTLER_MEMORY_SHOTS ?? resolve(tmpdir(), "butler-memory-settings-shots");
mkdirSync(output, { recursive: true });
const requested = process.env.BUTLER_MEMORY_BROWSER ?? "chromium";
assert(["chromium", "webkit"].includes(requested));
const browser = await (requested === "webkit" ? webkit : chromium).launch().catch(async (error) => { await server.close(); throw error; });
const states = ["settings-search", "long", "instructions-scroll", "time-picker", "consolidation-idle", "consolidation-running", "consolidation-done", "consolidation-failed", "consolidation-busy", "consolidation-scheduled", "consolidation-race"];

async function fixture(page: Page, state: string) {
  let id = crypto.randomUUID();
  let active = state === "consolidation-scheduled";
  let last: { at: string; status: string; trigger: string } | null = null;
  let reads = 0, posts = 0;
  let settings = { ...EMPTY_SETTINGS, language: "ko" };
  const receipt = () => ({ kind: "consolidation", operation_id: id, sequence: 1, phase: "running", trigger: state === "consolidation-scheduled" ? "scheduled" : "manual" });
  const kinds = [
    { kind: "pinned", item_count: 12, health: {} },
    { kind: "automatic", item_count: 1284, allocated_bytes: 1.7 * 1024 ** 3, health: { reclaimable_bytes: 512 * 1024 ** 2 } },
    { kind: "profile", item_count: 24, pending_count: 6, allocated_bytes: 96 * 1024, health: { consent_on: false } },
  ];
  const instructions = Array.from({ length: state === "instructions-scroll" ? 12 : 3 }, (_, index) => ({
    handle: `R${String(index).padStart(10, "0")}`, revision: "1", project_id: null, scope: { kind: "all" }, duration: "always",
    text: "첫 줄의 위치를 유지합니다. Keep the first line fixed.\n" + "Include every relevant example and preserve the evidence. ".repeat(10),
  }));
  await page.route(url => !url.pathname.includes("/src/") && ["/memory/", "/settings", "/projects", "/setup/", "/personalization"].some(prefix => url.pathname.startsWith(prefix)), async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (data: unknown, status = 200) => route.fulfill({ status, json: { protocol_version: "butler.app.v1", data } });
    if (path === "/memory/consolidation") {
      if (route.request().method() === "POST") {
        posts++;
        if (state === "consolidation-race") return route.fulfill({ status: 409, json: { error: { code: "memory_operation_unavailable" } } });
        id = route.request().postDataJSON().operation_id; active = true;
        return send(receipt(), 202);
      }
      reads++;
      return send({ active: active ? receipt() : undefined, last_run: last, time_of_day: "04:00" });
    }
    if (path.includes("inventory")) return send({ revision: 1, kinds, operation: state === "consolidation-busy" ? { operation_id: crypto.randomUUID(), phase: "preparing", sequence: 1, bytes_reclaimed: 0 } : undefined });
    if (path === "/memory/instructions") return send({ instructions });
    if (path === "/projects") return send({ projects: [{ id: "sample-project", display_name: "Project" }] });
    if (path.startsWith("/memory/projects/")) return send({ project_id: "sample-project", conversations: 5, instructions: 2, summary_bytes: 1024 });
    if (path === "/setup/readiness") return send({ status: "ready", steps: [], memory_model: { state: "ready", bytes_done: 100, bytes_total: 100 } });
    if (path === "/settings") {
      if (route.request().method() === "PATCH") settings = { ...settings, ...route.request().postDataJSON() };
      return send(settings);
    }
    if (path === "/personalization") return send({ profiling: { mode: "off" } });
    return send({});
  });
  return { settings: () => settings, counts: () => ({ reads, posts }), finish: async (failed: boolean) => {
    active = false;
    last = { at: new Date().toISOString(), status: failed ? "error" : "ok", trigger: receipt().trigger };
    await page.evaluate(payload => {
      (window as unknown as { emitMemorySettingsEvent: (event: unknown) => void }).emitMemorySettingsEvent({ type: "memory.operation", payload });
    }, { ...receipt(), sequence: 2, phase: failed ? "failed" : "complete" });
  } };
}

try {
  const selected = process.env.BUTLER_MEMORY_STATES?.split(",") ?? states;
  assert(selected.every(state => states.includes(state)), "known memory smoke states");
  for (const state of process.env.BUTLER_MEMORY_SCREENSHOTS_ONLY ? [] : selected) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
    try {
      const data = await fixture(page, state);
      await page.goto(`http://127.0.0.1:${port}/__memory_settings?locale=ko${state === "settings-search" ? "&page=models" : ""}`);
      if (state === "settings-search") {
        await page.locator('[data-settings-section-id="butler-model"]').waitFor();
        await page.locator("#settings-navigation-search").fill("기억 정리");
      }
      await page.locator('[data-settings-section-id="instructions"] [data-slot="expandable-text"]').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (state === "long") await checkInstructionGeometry(page);
      else if (state === "instructions-scroll") await checkInstructionScroll(page);
      else if (state === "time-picker") {
        await checkTimePicker(page, "ko");
        assert.equal(data.settings().consolidation_time, "04:05", "keyboard change saved via PATCH /settings");
      }
      else if (state !== "settings-search") await checkConsolidationControls(page, "ko", state, data);
      await page.screenshot({ path: resolve(output, `${requested}-${state}.png`), fullPage: true });
      console.log(`${requested}: ${state} passed`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `${requested}-${state}-failed.png`), fullPage: true });
      console.error(await page.locator("body").innerText());
      throw error;
    } finally { await page.close(); }
  }
  for (const section of process.env.BUTLER_MEMORY_STATES ? [] : ["memory", "models"]) for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
    if (process.env.BUTLER_MEMORY_SCREENSHOT_CELLS && !process.env.BUTLER_MEMORY_SCREENSHOT_CELLS.split(",").includes(`${section}-${theme}-${width}`)) continue;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    try {
      await fixture(page, "consolidation-idle");
      await page.goto(`http://127.0.0.1:${port}/__memory_settings?locale=ko&theme=${theme}&page=${section}`);
      await page.locator(`[data-settings-section-id="${section === "memory" ? "instructions" : "butler-model"}"]`).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (section === "models") {
        await page.locator('[data-test-class="settings-models-advanced"]').getByRole("button").click();
        assert.equal(await page.locator('[data-settings-section-id="memory-cleanup"]').count(), 0);
      } else {
        const ids = await page.locator('[data-settings-section-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section-id")));
        assert.deepEqual(ids, ["instructions", "chat-memory", "memory-cleanup", "memory-model", "profile-memory", "project-memory"]);
        for (const id of ids) await page.locator(`[data-settings-section-id="${id}"]`).screenshot({ path: resolve(output, `${requested}-${section}-${theme}-${width}-${id}.png`) });
      }
      await page.screenshot({ path: resolve(output, `${requested}-${section}-${theme}-${width}.png`), fullPage: true });
      console.log(`${requested}: ${section}/${theme}/${width} screenshot`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server.close(); }
