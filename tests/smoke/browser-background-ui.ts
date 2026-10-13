// test-category: pure-logic
/** Parent toggle through the product container, including child-owned preload tabs. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "browser-background-ui-"));
const ui = resolve("packages/butler-app/client/ui");
const { build } = await import(resolve(ui, "node_modules/vite/dist/node/index.js"));
writeFileSync(join(scratch, "index.html"), `<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="${resolve("tests/support/browser-area-harness.tsx")}"></script>`);
await build({ configFile: false, root: scratch, logLevel: "error",
  resolve: { alias: { "@/butler-ds": resolve(ui, "src/libs/design-system/index.ts"), "@": resolve(ui, "src"), "react-dom": resolve(ui, "node_modules/react-dom"), "react": resolve(ui, "node_modules/react") } },
  build: { outDir: join(scratch, "dist") } });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/authority-requests") return Response.json({ protocol_version: "butler.app.v1", data: { session_id: "general", requests: [], items: [], permissions: [] } });
  const file = Bun.file(join(scratch, "dist", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
const browser = await launchSmokeBrowser();
const selector = '[data-test-class="titlebar-browser-toggle"]';
let checks = 0;
async function closeHarness() {
  try { await browser.close(); }
  catch (error) { writeFileSync(join(evidence!, "teardown-failure.json"), JSON.stringify({ error: String(error) })); throw error; }
  finally { server.stop(true); rmSync(scratch, { recursive: true, force: true }); }
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => { writeFileSync(join(evidence, "page-error.txt"), String(error.stack)); });
  await page.goto(`http://127.0.0.1:${server.port}/?state=background`);
  const button = page.locator(selector);
  try { await button.waitFor(); } catch (error) {
    writeFileSync(join(evidence, "harness-failure.html"), await page.content());
    await page.screenshot({ path: join(evidence, "harness-failure.png") }); throw error;
  }
  const tab = { id: "child-tab", owner: "conversation:child", agent: true, busy: true,
    title: "Child page", url: "https://example.com/", favicon: "", status: "idle", canBack: false, canForward: false };
  const views = [{ session_id: "general", steward_children: [{ relation: { parent_session_id: "general", child_session_id: "child" } }] },
    { session_id: "child", steward_children: [{ relation: { parent_session_id: "child", child_session_id: "grandchild" } }] }];
  async function push(tabs: unknown[], relations: unknown[] = views, session = "general") {
    await page.evaluate(async next => {
      const bridge = (window as unknown as { butlerBrowser: { call(op: string, input: unknown): Promise<unknown> } }).butlerBrowser;
      await bridge.call("smoke-state", next);
    },
      { browser: { enabled: true, blocked: false, activeId: null, nativeCovered: false, tabs }, views: relations, session });
  }
  async function state(active: boolean) {
    await page.waitForFunction(({ selector, active }) => {
      const button = document.querySelector(selector)!;
      return (button.getAttribute("data-tone") === "riso") === active
        && Boolean(button.querySelector('[data-slot="icon-button-indicator"]')) === active;
    }, { selector, active });
    assert.equal(await button.getAttribute("aria-pressed"), "false"); checks++;
  }
  for (const theme of ["light", "dark"]) for (const width of [1440, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.port}/?state=background&theme=${theme}`);
    await button.waitFor();
    await push([]); await state(false);
    await page.screenshot({ path: join(evidence, `${theme}-${width}-before.png`) });
    await push([tab]); await state(true);
    await page.screenshot({ path: join(evidence, `${theme}-${width}-child-busy.png`) });
  }
  await push([tab], []); await state(false); // Relationship arriving after tab metadata is reactive.
  await push([tab]); await state(true);
  await push([{ ...tab, busy: false, inUse: true }]); await state(true);
  await push([{ ...tab, agent: false, driven: true }]); await state(true);
  await push([{ ...tab, owner: "conversation:grandchild" }]); await state(true);
  await push([{ ...tab, owner: "conversation:unrelated" }]); await state(false);
  await push([{ ...tab, owner: "mine" }]); await state(false);
  await push([{ ...tab, owner: "conversation:general", agent: false }]); await state(false);
  await push([tab], views, "unrelated"); await state(false);
  await push([{ ...tab, busy: false }]); await state(false);
  await push([]); await state(false);
  // The globe opens the tab Butler is using, not the conversation's last viewed tab.
  await push([{ ...tab, id: "older", owner: "conversation:general", agent: false, busy: false }, { ...tab, id: "working", owner: "conversation:general" }]);
  await state(true);
  type Bridge = { butlerBrowser: { call(op: string, input?: unknown): Promise<{ activeId: string | null } | undefined> } };
  const active = () => page.evaluate(async () => (await (window as unknown as Bridge).butlerBrowser.call("state"))?.activeId);
  await page.evaluate(() => (window as unknown as Bridge).butlerBrowser.call("activate", { id: "older" }));
  await button.click();
  for (let attempt = 0; await active() !== "working"; attempt++) {
    assert.ok(attempt < 50, "globe opens Butler's working tab"); await page.waitForTimeout(100);
  }
  checks++;
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ functional: "passed", checks, screenshots: 8, liveModelCalls: 0 }));
  console.log(JSON.stringify({ functional: "passed", checks, screenshots: 8 }));
} finally { await closeHarness(); }
