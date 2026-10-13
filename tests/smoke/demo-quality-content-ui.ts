// Offline public conversation renderer: complete five-column cells at both desktop widths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, preview } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const evidence = process.env.BUTLER_DEMO_QUALITY_EVIDENCE;
assert(evidence, "evidence directory required");
mkdirSync(evidence, { recursive: true });
const stage = process.env.BUTLER_DEMO_QUALITY_STAGE ?? "after";
const columns = ["Method", "Features", "Availability", "Limitations", "Notes"];
const rows = [
  ["First approach", "Several independent inputs are combined", "Available", "Needs a complete source for every input", "Keeps all the collected information"],
  ["Second approach", "Each input can be checked separately", "Available today", "The initial setup takes an extra step", "Sources remain easy to inspect"],
  ["Third approach", "The result includes a detailed comparison", "Available on request", "Some inputs need additional confirmation", "All required checks stay visible"],
];
const fixture = { background: "plain", messages: [{ id: "quality-answer", chat_id: "butler-client", role: "assistant", status: "delivered",
  text: "Three methods compared.", created_at: "2026-10-13T08:00:00+09:00",
  answer_blocks: [{ call_id: "quality-blocks", set_ids: [], spec: { v: 1, blocks: [{ type: "table", columns, rows }] } }] }] };
const root = process.cwd();
process.chdir(join(root, "packages/butler-app/client/ui"));
const baseline = stage === "before" ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "quality-baseline-")) : undefined;
if (baseline) {
  const file = "packages/butler-app/client/ui/src/components/conversation/AnswerDataBlocks.tsx";
  const source = execFileSync("git", ["show", `${process.env.BUTLER_DEMO_BASE_REF ?? "origin/main"}:${file}`], { cwd: root, encoding: "utf8" });
  await build({ build: { outDir: baseline }, plugins: [{ name: "baseline-answer-renderer", enforce: "pre",
    load: id => id === join(root, file) ? source : undefined }] });
}
const vite = await preview({ preview: { host: "127.0.0.1", port: 0 }, ...(baseline ? { build: { outDir: baseline } } : {}) });
const base = vite.resolvedUrls!.local[0];
console.log("UI server ready");
const browser = await chromium.launch({ headless: true, channel: "chromium", args: smokeBrowserArgs() });
console.log("Browser ready");
const results: unknown[] = [];
try {
  const page = await browser.newPage({ locale: "en-US", reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const width of [390, 960, 1440]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) {
    fixture.background = background;
    await page.setViewportSize({ width, height: 800 });
    console.log(`Opening ${stage} ${width} ${theme}`);
    await page.goto(`${base}?visual=components&theme=${theme}&locale=en`, { waitUntil: "domcontentloaded" });
    const table = page.locator('[data-answer-block="table"] table').first();
    await table.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await table.locator("thead th").allTextContents(), columns);
    assert.deepEqual(await table.locator("tbody tr").evaluateAll(nodes => nodes.map(node => [...node.children].map(cell => cell.textContent))), rows);
    const geometry = await table.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth,
      cellWidths: [...node.querySelectorAll("th,td")].map(cell => cell.getBoundingClientRect().width),
      headerWrap: getComputedStyle(node.querySelector("th")!).whiteSpace }));
    if (stage === "after" && width >= 960) assert(geometry.scroll <= geometry.client + 1, `table overflow at ${width}: ${JSON.stringify(geometry)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no page horizontal overflow");
    results.push({ width, theme, background, ...geometry });
    await page.screenshot({ path: join(evidence, `table-${stage}-${width}-${theme}-${background}.png`) });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, `table-${stage}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ok: true, stage, results, modelCalls: 0 }));
} catch (error) { console.error(error); throw error; } finally { await browser.close(); await new Promise<void>((done, reject) => vite.httpServer.close(error => error ? reject(error) : done()));
  if (baseline) rmSync(baseline, { recursive: true, force: true }); process.chdir(root); }
