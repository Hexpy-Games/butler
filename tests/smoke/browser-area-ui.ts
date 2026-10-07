/** Browser UI acceptance uses real product containers, no native-view claims. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { readProductFeatures } from "../../packages/butler-app/client/electron/product-features.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { createNativeAppServer } from "../support/native-app-server";

const root = process.cwd();
// Exercise release selection and the real sandbox preload in this smoke.
for (const ref of ["refs/heads/main", "refs/heads/release/0.1.0-preview.11", "refs/tags/v0.1.0-preview.11", "refs/tags/v0.1.0-preview.10"]) {
  const result = JSON.parse(execFileSync("python3", [".github/scripts/product-features.py"], {
    env: { ...process.env, GITHUB_REF: ref, GITHUB_REF_NAME: ref.split("/").at(-1)!, GITHUB_ENV: "" }, encoding: "utf8",
  }));
  assert.equal(result.browser, ref !== "refs/tags/v0.1.0-preview.11");
}
for (const enabled of [true, false]) {
  const exposed = new Set<string>();
  runInNewContext(readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8"), {
    URL, URLSearchParams,
    process: { env: { BUTLER_APP_SERVER_PORT: "12345" }, argv: enabled ? [] : ["--butler-browser-disabled"] },
    require: () => ({ contextBridge: { exposeInMainWorld: (name: string) => exposed.add(name) }, ipcRenderer: { on() {}, invoke() {} } }),
  });
  assert(exposed.has("butlerApp"));
  assert.equal(exposed.has("butlerBrowser"), enabled);
}
assert.equal(readProductFeatures(undefined).browser, true);

const scratch = mkdtempSync(join(tmpdir(), "browser-ui-"));
for (const enabled of [true, false]) {
  writeFileSync(join(scratch, "product-features.json"), JSON.stringify({ browser: enabled }));
  assert.equal(readProductFeatures(scratch).browser, enabled);
}
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
if (!evidence) throw new Error("BUTLER_BROWSER_EVIDENCE is required");
mkdirSync(evidence, { recursive: true });
const uiRoot = resolve(root, "packages/butler-app/client/ui");
const { build } = await import(resolve(uiRoot, "node_modules/vite/dist/node/index.js"));
const entry = join(scratch, "index.html");
writeFileSync(entry, `<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="${resolve(root, "tests/support/browser-area-harness.tsx")}"></script>`);
async function buildHarness(browserEnabled?: boolean) {
await build({ configFile: false, root: scratch, logLevel: "error",
  define: browserEnabled === undefined ? {} : { __BUTLER_BROWSER_ENABLED__: browserEnabled },
  resolve: { alias: { "@/butler-ds": resolve(uiRoot, "src/libs/design-system/index.ts"), "@": resolve(uiRoot, "src"), "react-dom": resolve(uiRoot, "node_modules/react-dom"), "react": resolve(uiRoot, "node_modules/react") } },
  build: { outDir: join(scratch, "dist"), rollupOptions: { input: entry } } });
}
await buildHarness();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/security") return Response.json({ protocol_version: "butler.app.v1", data: {
    remote_access_enabled: false, bind_addresses: [], lan_urls: [], allowed_hosts: [], content_hosts: [],
  } });
  if (path === "/authority-requests") return Response.json({ protocol_version: "butler.app.v1", data: { session_id: "general", requests: [], items: [], permissions: [] } });
  if (path.startsWith("/outputs/")) return Response.json({ protocol_version: "butler.app.v1", data: { url: "https://example.org/output.html", revision: 1, revisions: [1] } });
  const file = Bun.file(join(scratch, "dist", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
const browser = await launchSmokeBrowser();
let gateway: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
async function captureSecurity(enabled: boolean) {
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${server.port}/?locale=${locale}&theme=${theme}&state=security`);
      await page.locator('[data-test-class="settings-security-advanced"]').click();
      if (enabled) await page.getByPlaceholder("content.example.com").waitFor();
      assert.equal(await page.getByPlaceholder("content.example.com").count(), enabled ? 1 : 0);
      await page.screenshot({ path: join(evidence!, `gate-${enabled ? "on" : "off"}-${locale}-${theme}-${width}-security.png`) });
    } finally { await page.close(); }
  }
}

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
    assert.equal(await page.evaluate(async () => {
      const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ keyboardFocused: boolean }> } }).butlerBrowser;
      return (await bridge.call("state")).keyboardFocused;
    }), true, "address focus belongs to Browser keyboard scope");
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
  await captureSecurity(true);
  await buildHarness(false);
  await captureSecurity(false);
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) for (const state of ["idle", "output"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${server.port}/?locale=${locale}&theme=${theme}&state=${state}`);
      await page.getByRole("button", { name: "Overlay", exact: true }).waitFor();
      assert.equal(await page.locator('[data-test-class="browser-entry"]').count(), 0);
      assert.equal(await page.locator('[data-test-class="browser-area"]').count(), 0);
      assert.equal(await page.locator("iframe").count(), 0, "output viewer is absent");
      assert.equal(await page.getByText(locale === "ko" ? "브라우저" : "Browser", { exact: true }).count(), 0);
      const facts = await page.evaluate(async () => {
        const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: unknown[] }> } }).butlerBrowser;
        return bridge.call("state");
      });
      assert.equal(facts.tabs.length, state === "idle" ? 1 : 0, "gate-off never creates a tab");
      await page.screenshot({ path: join(evidence, `gate-off-${locale}-${theme}-${width}-${state}.png`) });
      await page.close();
    }
  }
  console.log("Browser UI: default-on behavior and gate-off entry/area/output checks passed (16 off cells)");
  if (process.env.BUTLER_BROWSER_UI_HARNESS_ONLY !== "1") {
  gateway = await createNativeAppServer({ uiRoot: resolve(uiRoot, "dist") });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await gateway.signIn(mobile);
  await mobile.goto(gateway.url);
  await mobile.locator('[data-test-class~="composer-card"]').waitFor();
  assert.equal(await mobile.locator('[data-test-class="browser-entry"]').count(), 0);
  assert.equal(await mobile.locator('[data-test-class="browser-area"]').count(), 0);
  await mobile.screenshot({ path: join(evidence, "web-390-no-browser.png") });
  await mobile.close();
  }
  writeFileSync(join(evidence, "ui-result.json"), JSON.stringify({ ok: true, screenshotCount: 54, native: false, viewport: 1440, webWidth: 390 }));
} finally {
  await browser.close(); server.stop(true); await gateway?.stop(); rmSync(scratch, { recursive: true, force: true });
}
