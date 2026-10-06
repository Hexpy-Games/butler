/** Browser UI acceptance uses real product containers, no native-view claims. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { createNativeAppServer } from "../support/native-app-server";

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "browser-ui-"));
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
if (!evidence) throw new Error("BUTLER_BROWSER_EVIDENCE is required");
mkdirSync(evidence, { recursive: true });
const uiRoot = resolve(root, "packages/butler-app/client/ui");
const { build } = await import(resolve(uiRoot, "node_modules/vite/dist/node/index.js"));
const entry = join(scratch, "index.html");
writeFileSync(entry, `<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="${resolve(root, "tests/support/browser-area-harness.tsx")}"></script>`);
await build({ configFile: false, root: scratch, logLevel: "error",
  resolve: { alias: { "@/butler-ds": resolve(uiRoot, "src/libs/design-system/index.ts"), "@": resolve(uiRoot, "src"), "react-dom": resolve(uiRoot, "node_modules/react-dom"), "react": resolve(uiRoot, "node_modules/react") } },
  build: { outDir: join(scratch, "dist"), rollupOptions: { input: entry } } });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/authority-requests") return Response.json({ protocol_version: "butler.app.v1", data: { session_id: "general", requests: [], items: [], permissions: [] } });
  if (path.startsWith("/outputs/")) return Response.json({ protocol_version: "butler.app.v1", data: { url: "https://example.org/output.html", revision: 1, revisions: [1] } });
  const file = Bun.file(join(scratch, "dist", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
const browser = await launchSmokeBrowser();
let gateway: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
try {
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const state of ["empty", "idle", "crash", "disabled"]) {
      await page.goto(`http://127.0.0.1:${server.port}/?locale=${locale}&theme=${theme}&state=${state}`);
      await page.locator('[data-test-class="browser-area"]').waitFor({ state: "attached" });
      writeFileSync(join(evidence, "harness-geometry.json"), JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("#root, [data-slot], [data-test-class]")].slice(0, 30).map(node => ({ tag: node.tagName, slot: node.getAttribute("data-slot"), test: node.getAttribute("data-test-class"), rect: node.getBoundingClientRect().toJSON(), display: getComputedStyle(node).display }))), null, 2));
      await page.screenshot({ path: join(evidence, "harness-debug.png") });
      await page.locator('[data-test-class="browser-area"]').waitFor();
      const slot = page.locator('[data-slot="native-view-slot"]');
      assert.equal(await slot.getAttribute("data-hidden"), state === "idle" ? null : "true");
      await page.screenshot({ path: join(evidence, `harness-${locale}-${theme}-${state}.png`) });
      if (state === "idle") {
        await page.getByRole("button", { name: "Overlay", exact: true }).click();
        await slot.locator("img").waitFor();
        assert.equal(await slot.getAttribute("data-occluded"), "true");
        await page.screenshot({ path: join(evidence, `harness-${locale}-${theme}-overlay-still.png`) });
        await page.keyboard.press("Escape");
      }
      if (state === "disabled") assert.equal(await page.locator('[data-test-class="browser-entry"]').getAttribute("aria-disabled"), "true");
    }
    await page.goto(`http://127.0.0.1:${server.port}/?locale=${locale}&theme=${theme}`);
    await page.getByRole("button", { name: locale === "ko" ? "새 탭" : "New tab", exact: true }).last().click();
    const address = page.getByRole("textbox", { name: locale === "ko" ? "주소" : "Address", exact: true });
    await address.fill("https://example.com/fixture"); await address.press("Enter");
    await page.getByRole("tab", { name: "Navigated fixture", exact: true }).waitFor();
    await page.getByRole("button", { name: locale === "ko" ? "새 탭" : "New tab", exact: true }).first().click();
    const newTab = page.getByRole("tab", { name: locale === "ko" ? "새 탭" : "New tab", exact: true });
    await newTab.focus(); await page.keyboard.press("Control+Shift+ArrowLeft");
    await page.waitForFunction(async () => {
      const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: Array<{ id: string }> }> } }).butlerBrowser;
      return (await bridge.call("state")).tabs[0]?.id === "new-2";
    });
    assert.equal(await page.locator('[role="tab"]').first().getAttribute("aria-label"), locale === "ko" ? "새 탭" : "New tab");
    await page.close();
  }
  const output = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await output.goto(`http://127.0.0.1:${server.port}/?locale=ko&theme=light&state=output`);
  await output.getByRole("button", { name: "브라우저에서 열기", exact: true }).click();
  await output.locator('[data-test-class="browser-area"]').waitFor();
  const outputOwner = await output.evaluate(async () => {
    const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: Array<{ owner: string; url: string }> }> } }).butlerBrowser;
    return (await bridge.call("state")).tabs[0];
  });
  assert.equal(outputOwner?.owner, "conversation:general");
  assert.equal(outputOwner?.url, "https://example.org/output.html");
  await output.screenshot({ path: join(evidence, "harness-ko-light-output-open.png") });
  await output.close();
  gateway = await createNativeAppServer({ uiRoot: resolve(uiRoot, "dist") });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await gateway.signIn(mobile);
  await mobile.goto(gateway.url);
  await mobile.locator('[data-test-class~="composer-card"]').waitFor();
  assert.equal(await mobile.locator('[data-test-class="browser-entry"]').count(), 0);
  assert.equal(await mobile.locator('[data-test-class="browser-area"]').count(), 0);
  await mobile.screenshot({ path: join(evidence, "web-390-no-browser.png") });
  await mobile.close();
  writeFileSync(join(evidence, "ui-result.json"), JSON.stringify({ ok: true, screenshotCount: 22, native: false, viewport: 1440, webWidth: 390 }));
} finally {
  await browser.close(); server.stop(true); await gateway?.stop(); rmSync(scratch, { recursive: true, force: true });
}
