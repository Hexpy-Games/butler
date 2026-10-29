// Real stub Turn → output store → isolated listener → the shared App UI.
import { verifyElectronHtml, verifyBrowserHtmlRefresh } from "../support/html-artifact-client-smoke";
import { htmlArtifactSmoke, htmlArtifactFixture } from "../support/html-artifact-smoke.ts";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Browser, type Page } from "playwright";
import { createNativeAppServer, freePort, type NativeAppServerHandle, type StubModelRequest } from "../support/native-app-server.ts";
import { spawnElectron, stopElectronChild } from "../support/electron-child.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { electronPage, electronFrame } from "../support/electron-page-cdp.ts";
import { outputTunnel } from "../support/output-tunnel.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

const screenshots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const electronOnly = process.env.BUTLER_SMOKE_ELECTRON_ONLY === "1";
const remoteOnly = process.env.BUTLER_SMOKE_OUTPUT_CASE === "remote";
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
if (screenshots) mkdirSync(screenshots, { recursive: true });
const marker = "Publish browser output";
// Background rounds (title, smart group) stream the same text but offer no tools; only the conversation turn does.
const isConversation = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools) && request.body.tools.length > 0
  && JSON.stringify(request.messages).includes(marker);
const sessionTitle = "Output task";
let sessionId = "";
// The virtual HTTPS fixture has no public certificate. Restricted Chromium
// uses a certificate exception and DNS mapping only for these local fixtures.
let browser!: Browser;
if (!electronOnly) browser = await launchSmokeBrowser(["--ignore-certificate-errors", "--host-resolver-rules=MAP butler.example.info 127.0.0.1, MAP outputs.example.info 127.0.0.1"]);

async function waitForOutput(server: NativeAppServerHandle): Promise<{ id: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { artifacts } = await server.api<{ artifacts: Array<{ id: string; kind: string }> }>(`/artifacts?session_id=${sessionId}`);
    const output = artifacts.find(item => item.kind === "web");
    if (output) return output;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Stub publication did not reach artifacts");
}
async function openViewer(page: Page, server: NativeAppServerHandle) {
  await page.goto(server.url, { waitUntil:"commit" });
  const general = page.locator('[data-test-class="app-sidebar"]').getByText(sessionTitle, { exact: true });
  const showSidebar = page.getByRole("button", { name:appCopy.titlebar.showLeftPanel, exact:true });
  await showSidebar.or(page.getByRole("button", { name:appCopy.titlebar.hideLeftPanel, exact:true })).waitFor();
  if (await showSidebar.isVisible()) await showSidebar.click();
  try { await general.click(); } catch (error) {
    await capture(page, "failed-sidebar");
    console.log("Sidebar was not ready at the unchanged deadline.");
    throw error;
  }
  const chip = page.locator('[data-test-class="message-artifact-list"]').getByText("Output", { exact: true }).first();
  try { await chip.waitFor(); } catch (error) {
    await capture(page, "failed-viewer");
    console.log(await page.locator("body").innerText());
    throw error;
  }
  await chip.click();
  await page.locator('[data-test-class="artifact-viewer"]').waitFor();
  if (!baseline) {
    const frame = page.frameLocator('[data-test-class="artifact-viewer"] iframe');
    try { await frame.getByRole("heading", { name: "Ready", exact: true }).waitFor(); } catch (error) {
      console.log(await page.locator("body").innerText());
      await capture(page, "failed-frame");
      throw error;
    }
    await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="artifact-viewer"] iframe')));
    const child = page.frames().find(frame => frame.url().includes("/__o/"))!;
    assert.equal(await child.evaluate(() => localStorage.getItem("output")), "ready");
    await child.waitForFunction(() => document.body.dataset.api === "blocked");
    assert.equal(await child.evaluate(() => typeof (window as unknown as { butlerApp?: unknown }).butlerApp), "undefined");
    const attributes = await page.locator('[data-test-class="artifact-viewer"] iframe').evaluate(node => ({ sandbox: node.getAttribute("sandbox"), referrer:node.getAttribute("referrerpolicy") }));
    assert.equal(attributes.sandbox, "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
    assert.equal(attributes.referrer, "no-referrer");
    await page.waitForFunction(()=> {
      const bounds = document.querySelector('[data-test-class="artifact-viewer"] iframe')?.getBoundingClientRect();
      return bounds && bounds.x >= 0 && bounds.right <= innerWidth;
    });
    const bounds = await page.locator('[data-test-class="artifact-viewer"] iframe').boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize()!.width, "frame fits client width");
  }
}
async function remoteClients(server: NativeAppServerHandle, language: string, adminHeaders: Record<string, string>) {
  await server.api("/settings", { method:"PATCH", headers:adminHeaders, body:JSON.stringify({ security:{ remote_access_enabled:true, allowed_hosts:["butler.example.info"], content_hosts:["outputs.example.info"] } }) });
  const exposure = await server.api<{ lan_urls:string[] }>("/security", { headers:adminHeaders });
  assert(exposure.lan_urls.length > 0, "LAN fixture binds a real address");
  const lan = `${exposure.lan_urls[0]}/`;
  const page = await browser.newPage({ viewport:{ width:390, height:1000 }, reducedMotion:"reduce" });
  try {
    await page.route(`${lan}**`, route=>route.continue({ headers:{ ...route.request().headers(), ...server.authHeaders } }));
    await openViewer(page, { ...server, url:lan });
    await capture(page, `lan-output-${language}-390`);
    await page.locator('[data-test-class="file-viewer-close"]').click();
    await page.locator('[data-test-class="file-viewer"]').waitFor({ state: "detached" });
    await page.locator('[data-test-class="message-artifact-list"]').getByText("standalone.HTML", { exact: true }).click();
    await page.frameLocator('[data-test-class="artifact-viewer"] iframe').locator("#html-output").waitFor();
    await page.frameLocator('[data-test-class="artifact-viewer"] iframe').getByRole("button", { name: "Interactive", exact: true }).click();
    await verifyBrowserHtmlRefresh(page, server, sessionId);
    await capture(page, `lan-${language}-390`);
  } finally { await page.close(); }
  const proxy = outputTunnel(server);
  const tunnel = await browser.newPage({ viewport:{ width:390, height:1000 }, reducedMotion:"reduce", ignoreHTTPSErrors:true });
  try {
    await server.api("/settings", { method:"PATCH", headers:adminHeaders, body:JSON.stringify({ security:{ remote_access_enabled:true, allowed_hosts:[proxy.apiHost], content_hosts:[proxy.contentHost] } }) });
    const { artifacts } = await server.api<{ artifacts: Array<{ title: string; url: string }> }>(`/artifacts?session_id=${sessionId}`);
    const file = artifacts.find(artifact => artifact.title === "standalone.HTML")!;
    const forwarded = await server.api<{ url: string }>(`${file.url}/view`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(new URL(forwarded.url).origin, `https://${proxy.contentHost}`);
    await openViewer(tunnel, { ...server, url:`https://${proxy.apiHost}/` });
    await capture(tunnel, `tunnel-output-${language}-390`);
    await tunnel.locator('[data-test-class="file-viewer-close"]').click();
    await tunnel.locator('[data-test-class="file-viewer"]').waitFor({ state: "detached" });
    await tunnel.locator('[data-test-class="message-artifact-list"]').getByText("standalone.HTML", { exact: true }).click();
    await tunnel.frameLocator('[data-test-class="artifact-viewer"] iframe').locator("#html-output").waitFor();
    const src = await tunnel.locator('[data-test-class="artifact-viewer"] iframe').getAttribute("src");
    assert.equal(new URL(src!).origin, `https://${proxy.contentHost}`);
    await tunnel.frameLocator('[data-test-class="artifact-viewer"] iframe').getByRole("button", { name: "Interactive", exact: true }).click();
    await verifyBrowserHtmlRefresh(tunnel, server, sessionId);
    await capture(tunnel, `tunnel-${language}-390`);
  } finally { try { await tunnel.close(); } finally { proxy.stop(); } }

}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  if (screenshots) await page.screenshot({ path: resolve(screenshots, `${baseline ? "before" : "after"}-${name}.png`) });
}

async function captureCell(server: NativeAppServerHandle, secret: string, language: string, width: number, theme: string, wallpaper: boolean) {
  await server.api("/settings", { method:"PATCH", body:JSON.stringify({ appearance_theme:theme, wallpaper:{ source:wallpaper ? { kind:"live", module:"butler.bloom", params:{ colors:"monochrome" } } : { kind:"none" } } }) });
  // Each visual cell owns fresh client state; Settings navigation is not carried
  // into a later locale/theme/viewport cell.
  const page = await browser.newPage({ viewport:{ width, height:1000 }, reducedMotion:"reduce" });
  try {
    await server.signIn(page);
    await page.route(`${server.url}**`, async route => {
      const path = new URL(route.request().url()).pathname;
      const headers = path.startsWith("/security") || path === "/settings" ? { ...server.authHeaders, "x-butler-admin":secret } : server.authHeaders;
      await route.continue({ headers:{ ...route.request().headers(), ...headers } });
    });

    await openViewer(page, server);
    if (!baseline && width === 1440 && theme === "light" && !wallpaper) {
      await page.getByRole("combobox", { name:appCopy.artifacts.revision }).selectOption("1");
      await page.frameLocator('[data-test-class="artifact-viewer"] iframe').getByRole("heading", { name:"Ready", exact:true }).waitFor();
      await page.getByRole("button", { name:appCopy.artifacts.reload, exact:true }).click();
      await page.frameLocator('[data-test-class="artifact-viewer"] iframe').getByRole("heading", { name:"Ready", exact:true }).waitFor();
      await page.getByRole("combobox", { name:appCopy.artifacts.revision }).selectOption("2");
    }
    await capture(page, `viewer-${language}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`);
    if (width === 390) {
      // On a phone the file viewer holds the workspace; closing it returns to the chat.
      await page.locator('[data-test-class="file-viewer-close"]').click();
      await page.locator('[data-test-class="file-viewer"]').waitFor({ state: "detached" });
      await page.getByRole("button", { name:appCopy.titlebar.showLeftPanel, exact:true }).click();
    }
    await page.getByRole("button", { name:appCopy.sidebar.settings, exact:true }).click();
    await page.getByRole("button", { name:appCopy.settings.sections.security, exact:true }).click();
    try { await page.locator('[data-test-class="settings-security-advanced"]').click(); } catch (error) { await capture(page,"failed-settings"); throw error; }
    if (!baseline) await page.getByText(appCopy.settings.security.contentHosts, { exact:true }).waitFor();
    await capture(page, `settings-${language}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`);
  } finally { await page.close(); }
}

async function electronClient(server: NativeAppServerHandle, language: string) {
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
  if (!executable) return;
  const port = await freePort();
  const childProcess = spawnElectron(executable,
    [resolve("packages/butler-app/client/electron"), `--remote-debugging-port=${port}`], {
      env: { ...process.env, BUTLER_DATA:server.butlerData,
        BUTLER_NATIVE_AGENT_EXECUTABLE:join(dirname(server.butlerData), "install/bin/butler-agent"),
        BUTLER_APP_SERVER_URL:server.url, BUTLER_APP_SERVER_PORT:String(server.port),
        BUTLER_APP_RENDERER_DIST:resolve("packages/butler-app/client/ui/dist"),
        BUTLER_APP_ELECTRON_USER_DATA_DIR:join(process.env.HOME!, `electron-${language}`),
        BUTLER_APP_DISABLE_SHELL_REGISTRATION:"1", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT:"1" },
    });
  let page: Awaited<ReturnType<typeof electronPage>> | undefined;
  let child: Awaited<ReturnType<typeof electronFrame>> = null;
  try {
    page = await electronPage(port);
    await page.waitForFunction(()=>document.readyState === "complete" && Boolean((window as unknown as { butlerApp?:unknown }).butlerApp));
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-test-class="app-sidebar"] *')).some(e=>e.textContent?.trim() === "Output task"));
    await page.expression(`document.querySelector('[data-test-class="app-sidebar"] [aria-label="${sessionTitle}"]').focus()`);
    await page.press("Enter");
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="message-artifact-list"] [aria-label="Output"]')));
    await page.clickText("Output", '[data-test-class="message-artifact-list"] *');
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="artifact-viewer"] iframe')));
    const origin = new URL(server.url);origin.port=String(server.port+1);
    const deadline = Date.now()+30_000;
    let facts: { title:string;storage:string;api:string;preload:string } | undefined;
    while (Date.now()<deadline) {
      child ??= await electronFrame(port, origin.origin);
      facts = await (child ? child.expression<typeof facts>("({title:document.querySelector('h1')?.textContent,storage:localStorage.getItem('output'),api:document.body.dataset.api,preload:typeof window.butlerApp})") : page.frameExpression<typeof facts>(origin.origin, "({title:document.querySelector('h1')?.textContent,storage:localStorage.getItem('output'),api:document.body.dataset.api,preload:typeof window.butlerApp})")).catch(()=>undefined);
      if (facts?.api === "blocked") break;
      await new Promise(done=>setTimeout(done, 100));
    }
    assert.deepEqual(facts, { title:"Ready", storage:"ready", api:"blocked", preload:"undefined" });
    if (screenshots) writeFileSync(join(screenshots, `after-electron-viewer-${language}-desktop.png`), await page.screenshot());
    child?.close(); child = null;
    await verifyElectronHtml(page, port, server, sessionId, language);
    console.log(`Electron app://butler viewer ${language}: passed`);
  } catch (error) {
    if (page) {
      console.log(await page.expression("document.body.innerText"));
      if (screenshots) writeFileSync(join(screenshots, `failed-electron-${language}.png`), await page.screenshot());
    }
    throw error;
  } finally {
    child?.close();
    page?.close();
    await stopElectronChild(childProcess);
  }
}

try {
  for (const language of ["en", "ko"]) {
    setAppCopyLanguage(language);
    let round = 0;
    let apiOrigin = "";
    const script = (revision: number) => `// revision ${revision}\nlocalStorage.setItem('output','ready');document.querySelector('h1').textContent='Ready';fetch('${apiOrigin}/health').then(()=>document.body.dataset.api='allowed').catch(()=>document.body.dataset.api='blocked');`;
    const server = await createNativeAppServer({ uiRoot: process.env.BUTLER_SMOKE_UI_ROOT,
      config: { user: { name: "Smoke", language } },
      stubReply: request => isConversation(request) ? "Published." : "{}",
      stubToolCall: request => {
        if (!isConversation(request)) return null;
        round++;
        if (round === 1) return { name: "write_file", arguments: { path: "site/index.html", content: "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><h1>Output</h1><p>Published page</p><script src='./app.js'></script>", create_parents:true } };
        if (round === 2) return { name: "write_file", arguments: { path: "site/app.js", content: script(1), create_parents:true } };
        if (round === 3) return { name: "write_file", arguments: { path: "standalone.HTML", content: htmlArtifactFixture(apiOrigin), create_parents: true } };
        // Only declared deliverables become artifact cards (215505b39); written files stay file changes.
        if (round === 4) return { name: "deliver_files", arguments: { files: [{ path: "standalone.HTML" }] } };
        // An unchanged publication only adds a reference (215505b39), so the second turn edits the script first.
        if (round === 7) return { name: "write_file", arguments: { path: "site/app.js", content: script(2), overwrite: true, expected_sha256: createHash("sha256").update(script(1)).digest("hex") } };
        if (round === 5 || round === 8) return { name: "output_publish", arguments: { path: "site", title: "Output" } };
        return null;
      },
    });
    try {
      apiOrigin = new URL(server.url).origin;
      sessionId = (await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: sessionTitle }) })).session.id;
      await server.api("/settings", { method:"PATCH", body:JSON.stringify({ access_mode:"full_access" }) });
      await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id:sessionId, text:marker, client_message_id:crypto.randomUUID() }) });
      const output = await waitForOutput(server);
      await server.api("/messages", { method:"POST", body:JSON.stringify({ chat_id:sessionId, text:`${marker} again`, client_message_id:crypto.randomUUID() }) });
      const deadline = Date.now()+30_000;
      while ((await server.api<{ revision:number }>(`/outputs/${output.id}/view`)).revision < 2) {
        assert(Date.now()<deadline, "republish reached revision 2");
        await new Promise(done=>setTimeout(done, 100));
      }
      if (process.env.BUTLER_SMOKE_OUTPUT_CASE === "html-file") {
        await htmlArtifactSmoke(server, browser, baseline, sessionId, sessionTitle);
        break;
      }
      if (!baseline && !electronOnly && !remoteOnly && language === "en") await htmlArtifactSmoke(server, browser, false, sessionId, sessionTitle);
      const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
      if (!electronOnly && !remoteOnly) {
        for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
          await captureCell(server, secret, language, width, theme, wallpaper);
        }
      }
      if (!baseline && !remoteOnly) await electronClient(server, language);
      if (!baseline && !electronOnly) await remoteClients(server, language, { ...server.authHeaders, "x-butler-admin":secret });
    } finally { await server.stop(); }
  }
  console.log(process.env.BUTLER_SMOKE_OUTPUT_CASE === "html-file" ? `HTML file ${baseline ? "source reproduced" : "rendering and isolation passed"}` : baseline ? "Baseline viewer/settings matrix captured (KO/EN, desktop/390px, themes/wallpaper)" : remoteOnly ? "Remote output/HTML viewers: KO/EN, LAN/HTTPS and forwarded content host passed" : electronOnly ? "Electron output viewer: KO/EN passed" : "Output viewer: JS, localStorage, API isolation, message chips, reload/revision, settings, desktop/390px, KO/EN, LAN/HTTPS fixture passed");
} catch (error) { console.error(error); throw error; }
finally { await browser?.close(); }
