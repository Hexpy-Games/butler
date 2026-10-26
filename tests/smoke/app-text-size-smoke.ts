// test-category: race
// Real Electron + isolated stub gateway. Native ready-to-show is observed before bootstrap runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { textSizeDriver, type TextSizePage as Page } from "../support/text-size-electron-driver";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { connectElectronMain } from "../support/electron-main-cdp";
import type { TextSizeMain } from "../support/text-size-electron-driver";
import { smokeElectronArgs } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";

const copy = getAppCopy("ko-KR");
const evidence = process.env.BUTLER_TEXT_SIZE_SHOTS ?? mkdtempSync(join(tmpdir(), "butler-text-size-evidence-"));
mkdirSync(evidence, { recursive: true });
const electronRoot = resolve("packages/butler-app/client/electron");
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert(executable, "BUTLER_SMOKE_ELECTRON_EXECUTABLE is required");
const server = await createNativeAppServer({ stubReply: () => Array.from({ length: 30 }, (_, i) => `${i + 1}. 읽기 쉬운 긴 답변입니다. 모든 내용과 문장을 그대로 표시합니다.`).join("\n\n") });
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(electronRoot, "package.json"))})`;
const electron = `${module}('electron')`;
const win = "globalThis.textSizeMainWindow";

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accepts(result)) return result;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function launch(waitForUi = true) {
  const scratch = mkdtempSync(join(tmpdir(), "butler-text-size-app-"));
  const inspector = await freePort(), debug = await freePort();
  const home = join(scratch, "home"); mkdirSync(home);
  const paintLog = join(scratch, "first-paints.jsonl");
  writeFileSync(paintLog, "");
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(electronRoot, "package.json"), "utf8")), main: "entry.mjs" }));
  writeFileSync(join(scratch, "entry.mjs"), `import {createRequire} from 'node:module';
    const {appendFileSync}=createRequire(${JSON.stringify(pathToFileURL(join(electronRoot, 'package.json')).href)})('node:fs');
    const {app}=createRequire(${JSON.stringify(pathToFileURL(join(electronRoot, "package.json")).href)})('electron');
    app.setAppPath(${JSON.stringify(electronRoot)});
    globalThis.textSizeFirstPaint=[];
    app.on('browser-window-created',(_event,w)=>{
      w.webContents.on('did-start-navigation',(_event,url,_inPlace,mainFrame)=>{if(mainFrame && url==='app://butler/index.html'){globalThis.textSizeMainWindow=w;w.setContentSize(1280,800);}});
      const initialZoom=w.webContents.getZoomFactor();
      w.once('ready-to-show',()=>{const paint={initialZoom,url:w.webContents.getURL(),zoom:w.webContents.getZoomFactor()};globalThis.textSizeFirstPaint.push(paint);appendFileSync(${JSON.stringify(paintLog)},JSON.stringify(paint)+'\\n');});
    });
    await import(${JSON.stringify(pathToFileURL(join(electronRoot, "bootstrap.mjs")).href)});`);
  const child = spawnElectron(executable!, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), scratch], {
    onOutput: bytes => appendFileSync(join(evidence, "electron.log"), bytes.toString().replace(/(__o\/)[^/\s]+/gu, "$1[redacted]")),
    env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: server.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(scratch, "profile"), BUTLER_APP_UI_URL: "",
      BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"), BUTLER_APP_SERVER_URL: server.url,
      BUTLER_APP_SERVER_PORT: String(server.port), BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub" },
  });
  let main: TextSizeMain | undefined;
  let page: Page | undefined;
  const stop = async () => {
    page?.close(); await stopElectronChild(child); await main?.close();
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    await until(() => fetch(`http://127.0.0.1:${inspector}/json/list`).then(r=>r.ok).catch(()=>false), Boolean, "main inspector");
    main = await connectElectronMain(inspector);
    await until(() => fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()).then((rows: Array<{url:string}>) => rows.some(r=>r.url.startsWith('app://butler/'))).catch(()=>false), Boolean, "App renderer");
    if (waitForUi) await until(() => main!.evaluate<boolean>(`Boolean(${win} && !${win}.isDestroyed())`), Boolean, "main window created");
    page = textSizeDriver(main, win);
    if (waitForUi) await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    const readFirstPaints = (): Array<{ url: string; zoom: number; initialZoom: number }> => readFileSync(paintLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { page, main, stop, readFirstPaints };
  } catch (error) { await stop(); throw error; }
}
async function shot(_page: Page, name: string) {
  const png = await app!.main.evaluate<string>(`${win}.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(image=>image.toPNG().toString("base64"))`);
  writeFileSync(join(evidence, `${name}.png`), Buffer.from(png, "base64"));
}
async function layout(page: Page, screen: string) {
  const result = await page.evaluate(() => {
    const clipped = [...document.querySelectorAll<HTMLElement>('button,label,[role="radio"],h1,h2,h3,p')].flatMap(node => {
      if (!node.checkVisibility() || !node.textContent?.trim()) return [];
      const style = getComputedStyle(node);
      // Intentional ellipsis is a disclosed compact label; clipped multiline content is a failure.
      if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") return [];
      if (node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1) return [];
      if (style.overflowX === "visible" && style.overflowY === "visible") return [];
      return [{ tag: node.tagName, slot: node.dataset.slot, text: node.textContent!.slice(0, 80),
        x: node.scrollWidth - node.clientWidth, y: node.scrollHeight - node.clientHeight }];
    });
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth, clipped };
  });
  console.log(JSON.stringify({ screen, ...result }));
  await shot(page, screen);
  assert(result.overflow <= 0, `${screen}: horizontal document overflow`);
  assert.deepEqual(result.clipped, [], `${screen}: clipped text`);
}
async function click(page: Page, name: string, scope = 'button,[role="button"]') {
  await until(() => page.expression<boolean>(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(e=>(e.getAttribute('aria-label')||e.textContent)?.trim()===${JSON.stringify(name)})`), Boolean, `control ${name}`);
  await page.clickText(name, scope);
}
async function appearance(page: Page) {
  await click(page, copy.sidebar.settings);
  await click(page, copy.settings.sections.appearance);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-setting-id="text-size"]')));
}
async function change(page: Page, label: string, factor: number) {
  await click(page, label, '[data-setting-id="text-size"] [role="radio"]');
  await until(() => page.expression<string>("document.documentElement.style.getPropertyValue('--ui-scale')"), value => value === String(factor), 'radius counter-scale');
}
async function cardRadius(main: TextSizeMain, factor: number): Promise<number> {
  return main.evaluate(`(async()=>{ const {BrowserWindow}=${electron}; const w=new BrowserWindow({show:false,webPreferences:{zoomFactor:${factor},sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try {await w.loadURL('app://butler/?visual=design-system&page=components/Card');return await w.webContents.executeJavaScript('new Promise(resolve=>{const check=()=>{const card=document.querySelector("[data-slot=card]");if(!card){setTimeout(check,20);return;}document.documentElement.style.setProperty("--ui-scale","${factor}");resolve(parseFloat(getComputedStyle(card).borderTopLeftRadius)*${factor});};check();})');} finally {w.destroy();}})()`);
}
async function radii(page: Page, factor: number) {
  return page.expression<Record<string, number>>(`(factor => {
    const selectors = ['[data-slot="button"]', '[data-test-class="composer-card"]'];
    return Object.fromEntries(selectors.map(selector => {
      const node = document.querySelector(selector);
      if (!node) throw new Error("Missing radius sample: " + selector);
      return [selector, parseFloat(getComputedStyle(node).borderTopLeftRadius) * factor];
    }));
  })(${factor})`);
}
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Local page</title><p>Independent browser zoom</p>", { headers: { "content-type": "text/html" } }) });
let app: Awaited<ReturnType<typeof launch>> | undefined;
try {
  await server.api('/settings', { method: 'PATCH', body: JSON.stringify({ text_size: 'larger' }) });
  app = await launch(false);
  const first = await until(() => Promise.resolve(app!.readFirstPaints()),
    entries => entries.some(entry => entry.url.startsWith('app://butler/')), 'first ready-to-show');
  writeFileSync(join(evidence, 'first-paints.json'), JSON.stringify(first, null, 2));
  assert(first.some(entry => entry.url.startsWith('app://butler/') && entry.zoom === 1.3), `first ready-to-show already uses 1.3: ${JSON.stringify(first)}`);
  console.log(JSON.stringify({ firstPaint: first, evidence, conditions: { electronArgs: smokeElectronArgs(), displayLock: 'reported by runner' } }));
  await app.stop(); app = undefined;
  await server.api('/settings' , { method: 'PATCH', body: JSON.stringify({ language: 'ko', text_size: 'default', appearance_theme: 'light', reduce_motion: true }) });
  app = await launch();
  const { page, main } = app;
  await shot(page, 'new-chat-before');
  const baseline = { ...await radii(page, 1), card: await cardRadius(main, 1) };
  await appearance(page);
  await shot(page, 'appearance-before');
  const origin = await page.evaluate(() => performance.timeOrigin);
  for (const [label, factor] of [[copy.settings.options.textSizeLarge, 1.15], [copy.settings.options.textSizeLarger, 1.3]] as const) {
    await change(page, label, factor);
    await until(() => main.evaluate<number>(`${win}.webContents.getZoomFactor()`), value => value === factor, 'native zoom');
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'setting applies without reload');
    await click(page, copy.settings.back);
    const values = { ...await radii(page, factor), card: await cardRadius(main, factor) };
    for (const selector of Object.keys(baseline)) assert(Math.abs(values[selector as keyof typeof values]! - baseline[selector as keyof typeof baseline]!) < 0.05, `${selector}: radius changed`);
    console.log(JSON.stringify({ factor, radiiDip: values }));
    await appearance(page);
  }
  for (const shortcut of ['Meta+Equal', 'Meta+Minus', 'Meta+0']) {
    await main.evaluate(`${win}.webContents.sendInputEvent({type:"keyDown",keyCode:${JSON.stringify(shortcut.split("+")[1])},modifiers:["meta"]});${win}.webContents.sendInputEvent({type:"keyUp",keyCode:${JSON.stringify(shortcut.split("+")[1])},modifiers:["meta"]})`);
    assert.equal(await main.evaluate(`${win}.webContents.getZoomFactor()`), 1.3, `${shortcut} does not desync text size`);
  }
  await layout(page, 'appearance-130');
  await click(page, copy.settings.back);
  await layout(page, 'new-chat-130');
  await page.clickSelector('[contenteditable=true]');
  await page.insertText('긴 답변을 보여 주세요.');
  await page.clickSelector('[data-test-class="composer-send-button"]');
  await page.waitForFunction(() => document.body.textContent?.includes('30. 읽기 쉬운 긴 답변입니다.'));
  await layout(page, 'long-chat-130');
  await click(page, copy.sidebar.search);
  await page.waitForFunction(() => Boolean(document.querySelector('[role=dialog]')));
  await layout(page, 'dialog-130');
  await page.press('Escape');
  await main.evaluate(`(()=>{const make=${module}(${JSON.stringify(join(electronRoot, "browser/tabs.mjs"))}).createUserBrowser;
    const dummy=make({getPath:()=>${JSON.stringify(evidence)},on:()=>{}},()=>null);const prototype=Object.getPrototypeOf(dummy),publish=prototype.publish;
    prototype.publish=function(){globalThis.textSizeBrowser=this;return publish.call(this)};})()`);
  await click(page, copy.browser.title);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-area"]')));
  const tabId = await page.expression<string>(`window.butlerBrowser.call('create',{owner:'mine',url:${JSON.stringify(site.url.href)}})`);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="native-view-slot"]')));
  await until(() => main.evaluate<number>(`${win}.contentView.children.filter(v=>v.webContents && v.webContents!==${win}.webContents).length`), count => count > 0, 'native page attached');
  const actual = await main.evaluate<Array<{x:number;y:number;width:number;height:number}>>(`(()=>{const w=${win};return w.contentView.children.filter(v=>v.webContents && v.webContents!==w.webContents).map(v=>v.getBounds())})()`);
  const slot = await page.evaluate(() => {
    const r = document.querySelector('[data-slot="native-view-frame"]')!.getBoundingClientRect();
    return { x: Math.round(r.x * 1.3), y: Math.round(r.y * 1.3), width: Math.round(r.width * 1.3), height: Math.round(r.height * 1.3) };
  });
  assert(actual.some(bounds => Object.keys(slot).every(key => Math.abs(bounds[key as keyof typeof slot] - slot[key as keyof typeof slot]) <= 1)), 'native view matches CSS slot × zoom');
  console.log(JSON.stringify({ tabId, slot, nativeBounds: actual }));
  await layout(page, 'browser-130');
  const webContents = `globalThis.textSizeBrowser.tabs.get(${JSON.stringify(tabId)}).view.webContents`;
  const agentId = await page.expression<string>(`window.butlerBrowser.call('create',{owner:'conversation:general',agent:true,url:${JSON.stringify(site.url.href)}})`);
  const agent = `globalThis.textSizeBrowser.tabs.get(${JSON.stringify(agentId)})`;
  await until(() => main.evaluate<boolean>(`Boolean(${agent}.view && ${agent}.loaded)`), Boolean, 'agent page loaded');
  await main.evaluate(`${webContents}.setZoomFactor(1.1)`);
  for (const [size, factor] of [['default',1],['large',1.15],['larger',1.3]] as const) {
    await page.expression(`window.butlerApp.setTextSize(${JSON.stringify(size)})`);
    assert.equal(await main.evaluate(`${webContents}.getZoomFactor()`), 1.1, "web page keeps its own zoom");
    const boundary = Math.floor(640 * factor);
    await main.evaluate(`${win}.setContentSize(${boundary},800)`);
    await page.waitForFunction(() => matchMedia('(max-width:640px)').matches);
    await main.evaluate(`${win}.setContentSize(${boundary + 2},800)`);
    await page.waitForFunction(() => !matchMedia('(max-width:640px)').matches);
    const agentState = await main.evaluate<{ zoom: number; scale: number; width: number; logicalWidth: number }>(`(async()=>{const t=${agent};return {zoom:t.view.webContents.getZoomFactor(),scale:t.bounds.scale,width:t.bounds.width,logicalWidth:await t.view.webContents.executeJavaScript('innerWidth')}})()`);
    assert.equal(agentState.zoom, 1, 'agent page zoom is independent');
    assert.equal(agentState.logicalWidth, 1280, 'agent logical viewport is unchanged');
    if (await main.evaluate<boolean>(`${agent}.bounds.visible`)) assert(Math.abs(agentState.scale - agentState.width / 1280) < 0.01, 'agent presentation scale follows native bounds');
    console.log(JSON.stringify({ factor, compactThroughDip: boundary, agent: agentState }));
  }

} finally { await app?.stop(); await server.stop(); await site.stop(true); }
