// Real stub Turn → output store → isolated listener → the shared App UI.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer, freePort, spawnTrackedProcess, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { electronPage, electronFrame } from "../support/electron-page-cdp.ts";
import { outputTunnel } from "../support/output-tunnel.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";

const screenshots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const electronOnly = process.env.BUTLER_SMOKE_ELECTRON_ONLY === "1";
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
if (screenshots) mkdirSync(screenshots, { recursive: true });
const marker = "Publish browser output";
// The virtual HTTPS fixture has no public certificate. Restricted Chromium
// uses a certificate exception and DNS mapping only for these local fixtures.
const browser = await launchSmokeBrowser(["--ignore-certificate-errors", "--host-resolver-rules=MAP butler.example.info 127.0.0.1, MAP outputs.example.info 127.0.0.1"]);

async function waitForOutput(server: NativeAppServerHandle): Promise<{ id: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { artifacts } = await server.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
    const output = artifacts.find(item => item.kind === "web");
    if (output) return output;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Stub publication did not reach artifacts");
}
async function openViewer(page: Page, server: NativeAppServerHandle) {
  await page.goto(server.url, { waitUntil:"commit" });
  const general = page.locator('[data-test-class="app-sidebar"]').getByText(appCopy.space.general, { exact: true });
  if (page.viewportSize()!.width === 390) await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact:true }).click();
  await general.click();
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
    await capture(page, `lan-${language}-390`);
  } finally { await page.close(); }
  const proxy = outputTunnel(server);
  const tunnel = await browser.newPage({ viewport:{ width:390, height:1000 }, reducedMotion:"reduce", ignoreHTTPSErrors:true });
  try {
    await server.api("/settings", { method:"PATCH", headers:adminHeaders, body:JSON.stringify({ security:{ remote_access_enabled:true, allowed_hosts:[proxy.apiHost], content_hosts:[proxy.contentHost] } }) });
    await openViewer(tunnel, { ...server, url:`https://${proxy.apiHost}/` });
    await capture(tunnel, `tunnel-${language}-390`);
  } finally { await tunnel.close(); proxy.stop(); }

}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  if (screenshots) await page.screenshot({ path: resolve(screenshots, `${baseline ? "before" : "after"}-${name}.png`) });
}

async function electronClient(server: NativeAppServerHandle, language: string) {
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
  if (!executable) return;
  const port = await freePort();
  const processHandle = spawnTrackedProcess(executable,
    [resolve("packages/butler-app/client/electron/main.mjs"), `--remote-debugging-port=${port}`], {
      stdio: "ignore",
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
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-test-class="app-sidebar"] *')).some(e=>e.textContent?.trim() === "General" || e.textContent?.trim() === "일반"));
    await page.clickText(appCopy.space.general, '[data-test-class="app-sidebar"] *');
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
    await processHandle.stop();
  }
}

try {
  for (const language of ["en", "ko"]) {
    setAppCopyLanguage(language);
    let round = 0;
    let apiOrigin = "";
    const server = await createNativeAppServer({ uiRoot: process.env.BUTLER_SMOKE_UI_ROOT,
      config: { user: { name: "Smoke", language } },
      stubReply: request => request.stream && JSON.stringify(request.messages).includes(marker) ? "Published." : "{}",
      stubToolCall: request => {
        if (!request.stream || !JSON.stringify(request.messages).includes(marker)) return null;
        round++;
        if (round === 1) return { name: "write_file", arguments: { path: "site/index.html", content: "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><h1>Output</h1><p>Published page</p><script src='./app.js'></script>", create_parents:true } };
        if (round === 2) return { name: "write_file", arguments: { path: "site/app.js", content: `localStorage.setItem('output','ready');document.querySelector('h1').textContent='Ready';fetch('${apiOrigin}/health').then(()=>document.body.dataset.api='allowed').catch(()=>document.body.dataset.api='blocked');`, create_parents:true } };
        if (round === 3 || round === 5) return { name: "output_publish", arguments: { path: "site", title: "Output" } };
        return null;
      },
    });
    try {
      apiOrigin = new URL(server.url).origin;
      await server.api("/settings", { method:"PATCH", body:JSON.stringify({ access_mode:"full_access" }) });
      await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id:"general", text:marker, client_message_id:crypto.randomUUID() }) });
      const output = await waitForOutput(server);
      await server.api("/messages", { method:"POST", body:JSON.stringify({ chat_id:"general", text:`${marker} again`, client_message_id:crypto.randomUUID() }) });
      const deadline = Date.now()+30_000;
      while ((await server.api<{ revision:number }>(`/outputs/${output.id}/view`)).revision < 2) {
        assert(Date.now()<deadline, "republish reached revision 2");
        await new Promise(done=>setTimeout(done, 100));
      }
      const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
      if (!electronOnly) {
      const page = await browser.newPage({ viewport: { width:1440, height:1000 }, reducedMotion:"reduce" });
      await server.signIn(page);
      await page.route(`${server.url}**`, async route => {
        const path = new URL(route.request().url()).pathname;
        const headers = path.startsWith("/security") || path === "/settings" ? { ...server.authHeaders, "x-butler-admin":secret } : server.authHeaders;
        await route.continue({ headers:{ ...route.request().headers(), ...headers } });
      });
      for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
        await server.api("/settings", { method:"PATCH", body:JSON.stringify({ appearance_theme:theme, wallpaper:{ source:wallpaper ? { kind:"live", module:"butler.bloom", params:{ colors:"monochrome" } } : { kind:"none" } } }) });
        await page.setViewportSize({ width, height:1000 });
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
          await page.locator('[data-test-class="right-panel-overlay-close"]').click();
          await page.getByRole("button", { name:appCopy.titlebar.showLeftPanel, exact:true }).click();
        }
        await page.getByRole("button", { name:appCopy.sidebar.settings, exact:true }).click();
        await page.getByRole("button", { name:appCopy.settings.sections.security, exact:true }).click();
        await page.locator('[data-test-class="settings-security-advanced"]').click();
        if (!baseline) await page.getByText(appCopy.settings.security.contentHosts, { exact:true }).waitFor();
        await capture(page, `settings-${language}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`);
      }
      await page.close();
      }
      if (!baseline) await electronClient(server, language);
      if (!baseline && !electronOnly) await remoteClients(server, language, { ...server.authHeaders, "x-butler-admin":secret });
    } finally { await server.stop(); }
  }
  console.log(baseline ? "Baseline viewer/settings matrix captured (KO/EN, desktop/390px, themes/wallpaper)" : electronOnly ? "Electron output viewer: KO/EN passed" : "Output viewer: JS, localStorage, API isolation, message chips, reload/revision, settings, desktop/390px, KO/EN, LAN/HTTPS fixture passed");
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); }
