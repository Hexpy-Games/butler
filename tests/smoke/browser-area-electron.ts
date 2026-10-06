/** Public Browser area on an isolated, real Electron App and stub gateway. */
import { spawn, type ChildProcess } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronPage, type ElectronPage as Page } from "../support/electron-page-cdp";

import { createNativeAppServer, freePort, liveTrackedProcessIds } from "../support/native-app-server";
import { alignment, idleWrites, publicationStub } from "../support/browser-area-acceptance";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy";
import { electronMain } from "../support/electron-main-cdp";
import { smokeElectronArgs } from "../support/smoke-browser";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "browser-area-"));
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
if (!evidence) throw new Error("BUTLER_BROWSER_EVIDENCE is required");
mkdirSync(evidence, { recursive: true });
const origin = "app://butler/";
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/heavy") return new Response("<title>Heavy</title><script>window.heavyTicks=0;setInterval(()=>{window.heavyTicks++;let a=[];for(let i=0;i<100000;i++)a.push(Math.sqrt(i));},16)</script><h1>Heavy page</h1>", { headers: { "content-type": "text/html" } });
  return new Response(`<title>${path === "/second" ? "Second" : "Fixture"}</title><h1>${path}</h1><a href="/second">Next</a><a href="/popup" target="_blank">Popup</a><input aria-label="Field">`, { headers: { "content-type": "text/html" } });
} });
let connected: Page | undefined;
let child: ChildProcess | undefined;
const inspectorPort = await freePort();
const electronModule = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve(root, "packages/butler-app/client/electron/package.json"))})('electron')`;
const main = <T>(expression: string) => electronMain<T>(inspectorPort, expression);
const win = `${electronModule}.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith(${JSON.stringify(origin)}))`;
const nativeCount = `${win}.contentView.children.filter(v=>'webContents' in v && v.webContents!==${win}.webContents).length`;
const evaluate = <T>(fn: () => T) => main<Awaited<T>>(`(${fn.toString()})()`);
let gateway: Awaited<ReturnType<typeof createNativeAppServer>> | undefined;
const logs: string[] = [];

async function stopApp() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await new Promise(done=>setTimeout(done, 100));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function quitAndStop(page: Page) {
  const quit = new Promise<{ code: number; windows: number; contents: string[] }>((done, fail) => {
    const timer = setTimeout(() => { watcher.close(); fail(new Error("Timed out: App quit event")); }, 30_000);
    const watcher = watch(evidence!, (_event, file) => {
      if (file !== "quit-events.json") return;
      try {
        const last = JSON.parse(readFileSync(join(evidence!, "quit-events.json"), "utf8")).at(-1);
        if (last?.event !== "quit") return;
        watcher.close();clearTimeout(timer);done(last);
      } catch { /* A later change notification observes the complete write. */ }
    });
  });
  await page.expression("window.butlerApp.quitApp({confirmed:true})");
  const result = await quit;
  assert.equal(result.code, 0);assert.equal(result.windows, 0);assert.deepEqual(result.contents, []);
  // Bare Electron 44 also remains resident after quit in this runner. Release
  // only our PID after the App has closed and flushed, then test real restore.
  connected?.close();await stopApp();
}

async function launch(): Promise<Page> {
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
  assert.ok(executable, "BUTLER_SMOKE_ELECTRON_EXECUTABLE must explicitly name Electron 44");
  const debugPort = await freePort();
  mkdirSync(join(dir, "home"), { recursive: true });
  child = spawn(executable, [`--inspect=${inspectorPort}`, `--remote-debugging-port=${debugPort}`,
    ...smokeElectronArgs(), resolve(root, "packages/butler-app/client/electron")], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(dir, "home"), BUTLER_HOME: join(dir, "home"), BUTLER_DATA: gateway!.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_UI_URL: "",
      BUTLER_APP_RENDERER_DIST: resolve(root, "packages/butler-app/client/ui/dist"),
      BUTLER_APP_SERVER_URL: gateway!.url, BUTLER_APP_SERVER_PORT: String(new URL(gateway!.url).port),
      BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1", BUTLER_E2E_TIER: "stub" } });
  child.on("exit", (code, signal)=>logs.push(JSON.stringify({ event:"child-exit", code, signal })));
  child.on("close", (code, signal)=>logs.push(JSON.stringify({ event:"child-close", code, signal })));
  child.stdout!.on("data", bytes => logs.push(String(bytes).replace(/(__o\/)[^/\s]+/gu, "$1[redacted]")));
  child.stderr!.on("data", bytes => logs.push(String(bytes).replace(/(__o\/)[^/\s]+/gu, "$1[redacted]")));
  const page = await electronPage(debugPort, origin);
  connected = page;
  await main(`(() => {${win}.show();${win}.focus();${win}.webContents.focus()})()`);
  assert.match(await main<string>("process.versions.electron"), /^44\./u);
  await main(`(() => {
    globalThis.browserTrace=[];globalThis.quitTrace=[];
    for(const event of ['before-quit','will-quit','quit']) ${electronModule}.app.on(event,(_event,code)=>{globalThis.quitTrace.push({event,code,at:Date.now(),windows:${electronModule}.BrowserWindow.getAllWindows().length,contents:${electronModule}.webContents.getAllWebContents().map(w=>w.getType())});process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(join(evidence!, "quit-events.json"))},JSON.stringify(globalThis.quitTrace))});
    const handlers=${electronModule}.ipcMain._invokeHandlers;
    const handler=handlers.get('butler-browser:call');
    handlers.set('butler-browser:call',async (event,op,input) => {
      const entry={op,value:input?.value,at:Date.now()};globalThis.browserTrace.push(entry);
      try{return await handler(event,op,input)}finally{entry.finished=Date.now();entry.children=${win}.contentView.children.length}
    });
  })()`);
  return page;
}

async function waitUntil(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(page: Page, name: string) {
  const selector = `Array.from(document.querySelectorAll('button,[role="button"]')).find(e =>
    (e.getAttribute('aria-label') || e.textContent).trim() === ${JSON.stringify(name)})`;
  await main(`${win}.webContents.focus()`);
  await waitUntil(() => page.expression(`(() => {
    const node=${selector};
    if (!node || node.disabled || node.getAttribute('aria-disabled')==='true') return false;
    const rect=node.getBoundingClientRect();
    if (rect.width<=0 || rect.y<0 || rect.bottom>innerHeight) return false;
    for(let parent=node;parent;parent=parent.parentElement) {
      if(parent.getAnimations().some(animation=>animation.playState==='running')) return false;
    }
    return true;
  })()`), `button ${name} ready`);
  await page.clickText(name, 'button,[role="button"]');
  if (name === "Browser" || name === "브라우저") await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-area"]')));
}
async function escape(page: Page) {
  await main(`${win}.webContents.focus()`);
  await page.expression("document.querySelector('[role=combobox]')?.focus()");
  await page.press("Escape");
}
async function navigate(page: Page, url: string) {
  await page.expression(`(() => {
    const input = document.querySelector('input[aria-label="Address"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(url)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await page.expression("document.querySelector('input[aria-label=\"Address\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
}

async function state(page: Page) {
  return await page.expression('window.butlerBrowser.call("state")') as { activeId: string; tabs: Array<{ id: string; title: string; url: string; status: string; canBack: boolean }> };
}
async function call(page: Page, op: string, input = {}) {
  return await page.expression(`window.butlerBrowser.call(${JSON.stringify(op)}, ${JSON.stringify(input)})`);
}
async function waitTitle(page: Page, title: string) {
  await waitUntil(async () => (await state(page)).tabs.some(tab => tab.title === title && tab.status === "idle"), `title ${title}`);
}
async function shot(_page: Page, name: string) {
  await _page.evaluate(() => new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  const executable = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE;
  assert.ok(executable, "BUTLER_WINDOW_CAPTURE_EXECUTABLE must name the platform window-capture example");
  const source = await main<string>(`${win}.getMediaSourceId()`);
  const id = source.split(":")[1];assert.ok(id && /^\d+$/u.test(id));
  const result = Bun.spawnSync([executable, id, join(evidence!, `${name}.png`)]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
}

async function artifact(page: Page) {
  await gateway!.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  setAppCopyLanguage("ko");
  await gateway!.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "Publish browser output", client_message_id: crypto.randomUUID() }) });
  let outputId = "";
  await waitUntil(async () => {
    const result = await gateway!.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
    outputId = result.artifacts.find(item=>item.kind === "web")?.id ?? "";
    return Boolean(outputId);
  }, "real stub publication");
  const view = await gateway!.api<{ url: string }>(`/outputs/${outputId}/view`);
  await waitUntil(async () => {
    const publication = await gateway!.api<{ latest_turn?: { state: string }; messages: Array<{ artifacts?: Array<{ id: string }> }> }>("/session-view?session_id=general");
    return publication.latest_turn?.state === "delivered" && publication.messages.some(message=>message.artifacts?.some(item=>item.id===outputId));
  }, "delivered output message");
  await page.reload();
  await waitUntil(() => page.expression(`Array.from(document.querySelectorAll('[data-test-class="app-sidebar"] *')).some(e=>e.textContent?.trim()===${JSON.stringify(appCopy.space.general)})`), "general navigation loaded");
  await page.clickText(appCopy.space.general, '[data-test-class="app-sidebar"] *');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="message-artifact-list"] [aria-label="Output"]')));
  await page.clickText("Output", '[data-test-class="message-artifact-list"] *');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="artifact-viewer"] iframe')));
  await click(page, "브라우저에서 열기");
  await waitTitle(page, "Published Browser Output");
  const snapshot = await state(page);
  const output = snapshot.tabs.find(tab=>tab.id === snapshot.activeId);
  assert.ok(output && (output as { owner?: string }).owner === "conversation:general", "artifact uses conversation tab");
  const publicationAddress = (url: URL) => {
    const [, route, capability, ...entry] = url.pathname.split("/");
    assert.equal(route, "__o");
    const [id, revision] = Buffer.from(capability?.split(".")[0] ?? "", "base64url").toString().split(":");
    return { origin:url.origin, id, revision, entry:entry.join("/") };
  };
  assert.deepEqual(publicationAddress(new URL(output.url)), publicationAddress(new URL(view.url)), "fresh capability addresses the published output revision");
  await shot(page, "ko-light-output-open");
  await call(page, "close", { id: output.id });
  await gateway!.api("/settings", { method:"PATCH", body:JSON.stringify({ language:"en", appearance_theme:"dark" }) });
  await page.reload(); await click(page, "Browser");
}

async function screenStates(page: Page, locale: string, theme: string) {
  await gateway!.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
  await page.reload();
  await click(page, locale === "ko" ? "브라우저" : "Browser");
  await shot(page, `${locale}-${theme}-idle`);
  await click(page, locale === "ko" ? "검색" : "Search");
  await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="native-view-slot"][data-occluded] img')));
  await page.waitForFunction(() => {
    const overlays = [...document.querySelectorAll('[data-slot="dialog-overlay"],[data-slot="dialog-content"]')];
    return overlays.length === 2 && overlays.every(node=>!node.getAnimations({ subtree:true }).some(animation=>animation.playState === "running"));
  });
  await waitUntil(() => main<boolean>(`${nativeCount} === 0`), "covered page detached");
  assert.ok(await main<boolean>(`${nativeCount} === 0`), "covered page detached");
  await shot(page, `${locale}-${theme}-overlay-still`);
  await escape(page);
  await waitUntil(() => main<boolean>(`${nativeCount} === 1`), "overlay native view restored");
  const snapshot = await state(page);
  const active = snapshot.tabs.find(tab=>tab.id === snapshot.activeId);
  assert.ok(active);
  await main(`(() => {const w=${win};w.contentView.children.find(v=>'webContents' in v && v.webContents!==w.webContents).webContents.forcefullyCrashRenderer()})()`);
  await waitUntil(async () => (await state(page)).tabs.some(tab=>tab.id===active.id && tab.status==="crashed"), "crash projection");
  await page.waitForFunction(() => document.querySelector('[data-slot="native-view-slot"]')?.getAttribute("data-hidden") === "true");
  await shot(page, `${locale}-${theme}-crash`);
  await click(page, locale === "ko" ? "새로고침" : "Reload");
  await waitTitle(page, active.title);
}
try {
  gateway = await createNativeAppServer({ uiRoot: resolve(root, "packages/butler-app/client/ui/dist"),
    stubReply: request => request.stream ? "Published." : "{}", stubToolCall: publicationStub() });
  await gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  let page = await launch();
  await main(`${win}.setSize(1440, 900)`);
  await page.waitForFunction(() => innerWidth === 1440);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-entry"]')));
  await quitAndStop(page);
  page=await launch();await main(`${win}.setSize(1440,900)`);
  await page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="browser-entry"]')));
  await shot(page, "before-en-light-workspace");
  assert.equal(await main<number>(`${electronModule}.webContents.getAllWebContents().length`), 1, "no web tab process before Browser activation");
  await page.clickText("General", '[data-test-class="app-sidebar"] *');
  await click(page, "Browser");
  await page.waitForFunction(() => document.body.textContent?.includes("Open a new tab"));
  for (const locale of ["ko", "en"]) for (const theme of ["dark", "light"]) {
    await gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ language:locale, appearance_theme:theme }) });
    await page.reload(); await click(page, locale === "ko" ? "브라우저" : "Browser");
    await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="native-view-slot"][data-hidden]')));
    await shot(page, `${locale}-${theme}-empty`);
  }
  await click(page, "New tab");
  await navigate(page, `http://127.0.0.1:${fixture.port}/first`);
  await waitTitle(page, "Fixture");
  let snapshot = await state(page); const first = snapshot.activeId;
  await navigate(page, `http://127.0.0.1:${fixture.port}/second`);
  await waitTitle(page, "Second");
  await click(page, "Back"); await waitTitle(page, "Fixture");
  await click(page, "Forward"); await waitTitle(page, "Second");
  await click(page, "Reload"); await waitTitle(page, "Second");
  await page.clickText("General", '[data-test-class="app-sidebar"] *');
  await click(page, "Browser");
  await waitTitle(page, "Second");
  await alignment(page, main, win, evidence);
  await call(page, "create", { url: "https://www.iana.org/" });
  await waitUntil(async () => (await state(page)).tabs.some(t => t.url.startsWith("https://www.iana.org") && t.title === "Internet Assigned Numbers Authority" && t.status === "idle"), "real HTTPS site");
  const loadStart = loadavg()[0];
  await evaluate(() => {
    const histogram = process.getBuiltinModule("node:perf_hooks")!.monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    (globalThis as unknown as { browserLoop: typeof histogram }).browserLoop = histogram;
  });
  await call(page, "create", { url: `http://127.0.0.1:${fixture.port}/heavy` });
  await waitTitle(page, "Heavy");
  await new Promise(done => setTimeout(done, 10_000));
  const loadBefore = loadavg()[0];
  const loop = await evaluate(() => {
    const histogram = (globalThis as unknown as { browserLoop: { percentile(p: number): number; max: number; disable(): void } }).browserLoop;
    histogram.disable(); return { p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
  });
  const heavy = (await state(page)).activeId;
  assert.equal((await state(page)).tabs.length, 3, "heavy measurement retains all tabs");
  writeFileSync(join(evidence, "main-loop.json"), JSON.stringify({ ...loop, loadAverage1m: loadStart, loadAverage1mEnd: loadBefore, loadAverage1mAfter: loadavg()[0] }));
  const heavyTicks = await main<number>(`${win}.contentView.children.find(v=>'webContents' in v && v.webContents!==${win}.webContents).webContents.executeJavaScript('window.heavyTicks')`);
  assert.ok(heavyTicks > 0, "heavy page actually executes work");
  assert.ok(loop.p99Ms <= 30 && loop.maxMs <= 200, JSON.stringify(loop));
  if (loadStart > cpus().length) {
    const repeatLoad = loadavg()[0];
    await main("(() => {globalThis.browserLoop.reset();globalThis.browserLoop.enable()})()");
    await new Promise(done=>setTimeout(done, 10_000));
    const repeated = await main<{ p99Ms:number;maxMs:number }>("(() => {const h=globalThis.browserLoop;h.disable();return {p99Ms:h.percentile(99)/1e6,maxMs:h.max/1e6}})()");
    const repeatTicks = await main<number>(`${win}.contentView.children.find(v=>'webContents' in v && v.webContents!==${win}.webContents).webContents.executeJavaScript('window.heavyTicks')`);
    writeFileSync(join(evidence, "main-loop-repeat.json"), JSON.stringify({ ...repeated, loadAverage1m:repeatLoad, loadAverage1mAfter:loadavg()[0], heavyTicksBefore:heavyTicks, heavyTicksAfter:repeatTicks }));
    assert.ok(repeatTicks>heavyTicks, "heavy page remains active throughout repeated measurement");
    assert.equal((await state(page)).tabs.length, 3, "repeat retains all tabs");
    assert.ok(repeated.p99Ms<=30 && repeated.maxMs<=200, JSON.stringify(repeated));
  }
  await call(page, "close", { id: heavy });
  snapshot = await state(page);
  await call(page, "move", { tabId: first, toGroupId: "mine", index: 1 });
  assert.equal((await state(page)).tabs[1]!.id, first);
  await call(page, "activate", { id: first });
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) await screenStates(page, locale, theme);
  await main(`(() => {const w=${win};w.contentView.children.find(v=>'webContents' in v && v.webContents!==w.webContents).webContents.forcefullyCrashRenderer()})()`);
  await page.waitForFunction(() => document.body.textContent?.includes("Tab crashed"));
  await shot(page, "en-dark-crash");
  await click(page, "Reload"); await waitTitle(page, "Second");
  await artifact(page);
  await call(page, "activate", { id:first });
  const ownedPids = await main<number[]>(`${electronModule}.app.getAppMetrics().map(p=>p.pid)`);
  await idleWrites(main, join(dir, "profile"), evidence, [...new Set([...ownedPids, ...liveTrackedProcessIds()])]);
  const restoredUrls = (await state(page)).tabs.map(tab=>tab.url);
  await quitAndStop(page);
  page = await launch();
  await main(`${win}.setSize(1440,900)`);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-entry"]')));
  await click(page, "Browser");
  await waitUntil(async () => (await state(page)).tabs.length === restoredUrls.length, "restore tab count");
  assert.deepEqual((await state(page)).tabs.map(tab=>tab.url), restoredUrls, "restart restores complete ordered URLs");
  const restoredFirst = (await state(page)).tabs.find(tab=>tab.url.endsWith("/second"))!.id;
  await call(page, "close", { id: restoredFirst }); assert.equal((await state(page)).tabs.length, 1);
  await shot(page, "restart-restored");
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    await gateway.api("/settings", { method:"PATCH", body:JSON.stringify({ language:locale, appearance_theme:theme }) });
    await page.reload(); await click(page, locale === "ko" ? "브라우저" : "Browser");
    await main(`(() => {for(let i=0;i<5;i++)${electronModule}.app.emit('child-process-gone',{}, {type:'GPU',reason:'crashed'})})()`);
    await waitUntil(async () => (await page.expression<{ enabled: boolean; blocked: boolean }>('window.butlerBrowser.call("state")')).blocked, "GPU loss breaker");
    assert.equal(await page.expression("document.querySelector('[data-test-class=\"browser-entry\"]').getAttribute(\"aria-disabled\")"), "true");
    await shot(page, `${locale}-${theme}-disabled`);
    if (!(locale === "en" && theme === "dark")) {
      await quitAndStop(page);page=await launch(); await main(`${win}.setSize(1440,900)`);
      await page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="browser-entry"]')));
    }
  }
  writeFileSync(join(evidence, "electron-result.json"), JSON.stringify({ ok: true, logs, tabs: (await state(page)).tabs.length }));
} catch (error) {
  if (gateway) {
    const publication = await gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general").then(view=>({ state:view.latest_turn?.state })).catch(error=>({ error:String(error) }));
    writeFileSync(join(evidence, "publication-failure.json"), JSON.stringify(publication));
  }
  writeFileSync(join(evidence, "quit-trace.json"), JSON.stringify(await main("globalThis.quitTrace").catch(()=>null)));
  if (connected) {
    writeFileSync(join(evidence, "failure-ipc.json"), JSON.stringify(await main("globalThis.browserTrace").catch(()=>null)));
    writeFileSync(join(evidence, "failure-dom.json"), JSON.stringify(await connected.expression("({text:document.body.innerText,focus:document.activeElement?.outerHTML,overlays:Array.from(document.querySelectorAll('[data-slot=dialog-overlay],[data-slot=dialog-content],[data-slot=native-view-slot]')).map(e=>({html:e.outerHTML.slice(0,1000),rect:e.getBoundingClientRect().toJSON()}))})").catch(()=>null)));
    await shot(connected, "electron-failure-screen").catch(()=>{});
  }
  writeFileSync(join(evidence, "electron-failure.txt"), `${String(error)}\n${logs.join("\n")}`);
  throw error;
} finally {
  connected?.close(); await stopApp(); fixture.stop(true); await gateway?.stop(); rmSync(dir, { recursive: true, force: true });
}
