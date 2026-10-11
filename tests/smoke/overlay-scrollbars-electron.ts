/** Windows native scrollbar guard: real App, public Browser tab, no CSS suppression.
 * Run with a built renderer and BUTLER_SMOKE_ELECTRON_EXECUTABLE (Electron 44).
 * An isolated external stub gateway may be supplied in BUTLER_APP_SERVER_URL.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { electronPage } from "../support/electron-page-cdp";
import { connectElectronMain } from "../support/electron-main-cdp";

assert.equal(process.platform, "win32", "This guard must measure native Windows scrollbars");
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert.ok(evidence && executable, "Explicit Electron executable and evidence directory required");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "overlay-scrollbars-"));
const entry = resolve("packages/butler-app/client/electron");
const debug = await freePort(), inspector = await freePort();
const gateway = process.env.BUTLER_APP_SERVER_URL ? null : await createNativeAppServer();
const serverUrl = process.env.BUTLER_APP_SERVER_URL ?? gateway!.url;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  return new Response(`<!doctype html><title>Native scrollbar guard</title>
    <style>body{margin:0;font:24px sans-serif}#nested,#custom{width:300px;height:160px;overflow:auto}
    #custom::-webkit-scrollbar{width:8px}#custom::-webkit-scrollbar-thumb{background:#777}</style>
    <h1>Native Windows scrollbars</h1><div id="nested" tabindex="0"><div style="height:1200px">Nested scroll area</div></div>
    <div id="custom"><div style="height:1200px">Website-owned 8px scrollbar</div></div>
    <div style="height:2000px">Complete document</div>`, { headers: { "content-type": "text/html" } });
} });
mkdirSync(join(dir, "home")); mkdirSync(join(dir, "data"));
const child = spawnElectron(executable, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, entry], {
  env: { ...process.env, HOME: join(dir, "home"), BUTLER_DATA: gateway?.butlerData ?? join(dir, "data"),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_UI_URL: "",
    BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"),
    BUTLER_APP_SERVER_URL: serverUrl, BUTLER_APP_SERVER_PORT: new URL(serverUrl).port,
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub",
    BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0" },
});
let page: Awaited<ReturnType<typeof electronPage>> | undefined;
let nativePage: Awaited<ReturnType<typeof electronPage>> | undefined;
let main: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(entry, "package.json"))})('electron')`;
const win = `${electron}.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'))`;
const tab = `${electron}.webContents.getAllWebContents().find(w=>w.getURL()===${JSON.stringify(fixture.url.href)})`;
const facts: unknown[] = [];
try {
  page = await electronPage(debug); main = await connectElectronMain(inspector);
  assert.match(await main.evaluate<string>("process.versions.electron"), /^44\./u);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button,[role="button"]')).some(button => /^(Browser|브라우저)$/u.test(button.textContent?.trim() ?? "")));
  await page.expression(`window.butlerBrowser.call('open')`);
  await page.expression(`window.butlerBrowser.call('create',{url:${JSON.stringify(fixture.url.href)}})`);
  const browserLabel = await page.expression<string>(`Array.from(document.querySelectorAll('button,[role="button"]')).find(button=>/^(Browser|브라우저)$/.test(button.textContent.trim())).textContent.trim()`);
  await page.clickText(browserLabel, 'button,[role="button"]');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-area"]')));
  await waitUntil(async () => Boolean(await main!.evaluate(`${tab}?.isLoading()===false`)), "Browser load");
  nativePage = await electronPage(debug, fixture.url.href);
  await waitUntil(() => nativePage!.expression("innerWidth > 0 && innerHeight > 0 && document.visibilityState === 'visible'"), "visible viewport");
  for (const theme of ["light", "dark"]) {
    await main.evaluate(`${electron}.nativeTheme.themeSource=${JSON.stringify(theme)}`);
    await main.evaluate(`${win}.show();${win}.focus();${tab}.focus()`);
    await nativePage.expression(`document.documentElement.style.colorScheme='${theme}';document.body.style.background='${theme === "dark" ? "#202020" : "#fff"}';document.body.style.color='${theme === "dark" ? "#eee" : "#111"}';scrollTo(0,0);document.getElementById('nested').scrollTop=0;document.getElementById('nested').focus();new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
    const metrics: Record<string, number> = await main.evaluate(`${tab}.executeJavaScript(${JSON.stringify(`(() => {
      const nested=document.getElementById('nested'),custom=document.getElementById('custom');
      return {width:innerWidth,client:document.documentElement.clientWidth,gutter:innerWidth-document.documentElement.clientWidth,
        height:innerHeight,scrollHeight:document.documentElement.scrollHeight,
        nestedGutter:nested.offsetWidth-nested.clientWidth,nestedMax:nested.scrollHeight-nested.clientHeight,
        customGutter:custom.offsetWidth-custom.clientWidth};})()` )})`);
    const rendererGutter: number = await page.expression(`(() => {
      const probe=document.createElement('div');probe.style.cssText='position:fixed;width:200px;height:100px;overflow:scroll;scrollbar-width:auto;scrollbar-gutter:auto';
      const content=document.createElement('div');content.style.height='1000px';probe.append(content);document.body.append(probe);
      const gutter=probe.offsetWidth-probe.clientWidth;probe.remove();return gutter;
    })()`);
    const measured = { theme, ...metrics, rendererGutter, keyboardTop: 0 };
    facts.push(measured);
    writeFileSync(join(evidence, `${theme}-native.png`), Buffer.from(await main.evaluate<string>(`(async()=> (await ${tab}.capturePage()).toPNG().toString('base64'))()`), "base64"));
    writeFileSync(join(evidence, `${theme}-app.png`), Buffer.from(await main.evaluate<string>(`(async()=> (await ${win}.capturePage()).toPNG().toString('base64'))()`), "base64"));
    writeFileSync(join(evidence, "result.json"), JSON.stringify(facts, null, 2));
    assert.ok(metrics.width > 0 && metrics.height > 0, "native page is displayed at a real viewport size");
    assert.ok(metrics.scrollHeight > metrics.height && metrics.nestedMax > 0, "real overflowing document and nested area");
    assert.equal(metrics.gutter, 0, `${theme}: native Browser document gutter`);
    assert.equal(metrics.nestedGutter, 0, `${theme}: native nested gutter`);
    assert.equal(rendererGutter, 0, `${theme}: App renderer gutter`);
    assert.equal(metrics.customGutter, 8, "website-owned scrollbar remains 8px");
    await nativePage.press("End");
    await waitUntil(async () => await nativePage!.expression<number>("document.getElementById('nested').scrollTop") > 0, "keyboard scroll");
    measured.keyboardTop = await nativePage.expression<number>("document.getElementById('nested').scrollTop");
    writeFileSync(join(evidence, "result.json"), JSON.stringify(facts, null, 2));
  }
  console.log("PASS: Windows real App/Browser gutters 0px, custom 8px, keyboard scrolls; light/dark");
} catch (error) {
  if (main) writeFileSync(join(evidence, "diagnostics.json"), JSON.stringify(await main.evaluate(`${electron}.webContents.getAllWebContents().map(w=>({url:w.getURL(),loading:w.isLoading()}))`)));
  if (page) writeFileSync(join(evidence, "failure-app.png"), await page.screenshot());
  throw error;
} finally {
  nativePage?.close(); page?.close(); main?.close(); await stopElectronChild(child);
  fixture.stop(true); await gateway?.stop(); rmSync(dir, { recursive: true, force: true });
}

async function waitUntil(read: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Native ${label} failed`);
}
