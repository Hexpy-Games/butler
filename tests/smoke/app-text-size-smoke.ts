// test-category: race
// Real Electron + isolated stub gateway. Native ready-to-show is observed before bootstrap runs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { electronPage, type ElectronPage as Page } from "../support/electron-page-cdp";
import { textSizeFactor } from "../../packages/butler-app/client/ui/src/app/textSize";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { connectElectronMain } from "../support/electron-main-cdp";
import { smokeElectronArgs } from "../support/smoke-browser";
import { visibleClipping } from "../support/visible-clipping";
import { verifyVisibleClipping } from "../support/visible-clipping-fixtures";
import { checkSuggestionStrips } from "../support/text-size-strip";
import { textSizeSweep } from "../support/text-size-sweep";
import { getAppCopy } from "../../packages/butler-i18n/src";

type TextSizeMain = Awaited<ReturnType<typeof connectElectronMain>>;

const copy = getAppCopy("ko-KR");
const layoutFailures: string[] = [];
const evidence = process.env.BUTLER_TEXT_SIZE_SHOTS ?? mkdtempSync(join(tmpdir(), "butler-text-size-evidence-"));
mkdirSync(evidence, { recursive: true });
const electronRoot = resolve("packages/butler-app/client/electron");
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert(executable, "BUTLER_SMOKE_ELECTRON_EXECUTABLE is required");
const server = await createNativeAppServer({ stubReply: () => Array.from({ length: 30 }, (_, i) => `${i + 1}번째 문단: 읽기 쉬운 긴 답변입니다. 모든 내용과 문장을 그대로 표시합니다.`).join("\n\n") });
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
async function launch() {
  const scratch = mkdtempSync(join(tmpdir(), "butler-text-size-app-"));
  const inspector = await freePort(), debug = await freePort();
  const home = join(scratch, "home"); mkdirSync(home);
  const paintLog = join(scratch, "first-paints.jsonl");
  writeFileSync(paintLog, "");
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(electronRoot, "package.json"), "utf8")), main: "entry.mjs" }));
  const renderer = join(scratch, "dist");
  cpSync(resolve("packages/butler-app/client/ui/dist"), renderer, { recursive: true });
  writeFileSync(join(renderer, "index.html"), readFileSync(join(renderer, "index.html"), "utf8")
    .replace("<head>", '<head><script src="./text-size-frame-probe.js"></script>'));
  writeFileSync(join(renderer, "text-size-frame-probe.js"), `new MutationObserver((_, observer) => {
    if (!document.querySelector('#root')?.childElementCount) return;
    observer.disconnect();
    requestAnimationFrame(() => { window.textSizeFirstFrame = {
      scale: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'), width: innerWidth,
    }; });
  }).observe(document, {childList:true, subtree:true});`);
  writeFileSync(join(scratch, "entry.mjs"), `import {createRequire} from 'node:module';
    const {appendFileSync}=createRequire(${JSON.stringify(pathToFileURL(join(electronRoot, 'package.json')).href)})('node:fs');
    const {app,Menu}=createRequire(${JSON.stringify(pathToFileURL(join(electronRoot, "package.json")).href)})('electron');
    const fail=error=>{appendFileSync(${JSON.stringify(join(evidence, 'native-errors.log'))},String(error?.stack||error)+'\\n');app.exit(1);};
    process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
    app.whenReady().then(()=>{globalThis.textSizeNativeMenu=Menu.getApplicationMenu();});
    app.setAppPath(${JSON.stringify(electronRoot)});
    globalThis.textSizeFirstPaint=[];
    app.on('browser-window-created',(_event,w)=>{
      w.webContents.on('did-start-navigation',(_event,url,_inPlace,mainFrame)=>{if(mainFrame && url==='app://butler/index.html'){globalThis.textSizeMainWindow=w;}});
      const initialZoom=w.webContents.getZoomFactor();
      w.once('ready-to-show',()=>{const paint={initialZoom,url:w.webContents.getURL(),zoom:w.webContents.getZoomFactor()};globalThis.textSizeFirstPaint.push(paint);appendFileSync(${JSON.stringify(paintLog)},JSON.stringify(paint)+'\\n');});
    });
    await import(${JSON.stringify(pathToFileURL(join(electronRoot, "bootstrap.mjs")).href)});`);
  const child = spawnElectron(executable!, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), scratch], {
    onOutput: bytes => appendFileSync(join(evidence, "electron.log"), bytes.toString().replace(/(__o\/)[^/\s]+/gu, "$1[redacted]")),
    env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: server.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(scratch, "profile"), BUTLER_APP_UI_URL: "",
      BUTLER_APP_RENDERER_DIST: renderer, BUTLER_APP_SERVER_URL: server.url,
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
    page = await electronPage(debug);
    await main.evaluate(`${win}.setContentSize(1280,800);${win}.show();${win}.focus();${win}.webContents.focus()`);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    const readFirstPaints = (): Array<{ url: string; zoom: number; initialZoom: number }> => readFileSync(paintLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { page, main, stop, readFirstPaints, debug };
  } catch (error) { await stop(); throw error; }
}
function measureLayout(cuts: ReturnType<typeof visibleClipping>) {
  const clipped = [...document.querySelectorAll<HTMLElement>('*')].flatMap(node => {
    if (!node.checkVisibility() || !node.textContent?.trim()) return [];
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    // Visually hidden accessibility labels do not paint text.
    if (rect.width <= 1 && rect.height <= 1 && (style.clip !== "auto" || style.clipPath !== "none")) return [];
    // Intentional ellipsis is a disclosed compact label; clipped multiline content is a failure.
    if (style.textOverflow === "ellipsis") return [];
    if (node.scrollWidth <= node.clientWidth + 1) return [];
    if (!["hidden", "clip"].includes(style.overflowX)) return [];
    // Scroll extents include decorative descendants and pseudo-elements.
    // Require painted text or control geometry to cross this clipping box.
    const left = rect.left + parseFloat(style.borderLeftWidth);
    const right = rect.right - parseFloat(style.borderRightWidth);
    const ownTextCut = [...node.childNodes].some(child => {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) return false;
      const range = document.createRange(); range.selectNodeContents(child);
      return [...range.getClientRects()].some(box => box.left < left - 1 || box.right > right + 1);
    });
    const descendantCut = cuts.some(cut => ["left", "right"].includes(cut.side)
      && cut.ancestor !== "viewport" && document.querySelector(cut.ancestor) === node);
    if (!ownTextCut && !descendantCut) return [];
    return [{ tag: node.tagName, slot: node.dataset.slot, text: node.textContent!.slice(0, 80),
      x: node.scrollWidth - node.clientWidth, y: node.scrollHeight - node.clientHeight }];
  });
  return { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped };
}
async function layout(page: Page, screen: string) {
  const result = await page.expression<ReturnType<typeof measureLayout>>(`(${measureLayout.toString()})((${visibleClipping.toString()})())`);
  console.log(JSON.stringify({ screen, ...result }));

  if (result.overflow > 0 || result.clipped.length) layoutFailures.push(`${screen}: ${JSON.stringify(result)}`);
}
async function verifyLayoutClipping(page: Page) {
  const cases = [
    { name: "decorative extent", content: 'Readable<span aria-hidden="true" style="position:absolute;left:0;width:140px;height:30px"></span>', expected: 0 },
    { name: "decorative pseudo-element", css: '#clip::after{content:"";position:absolute;inset:0 -2px -2px}', content: "Readable", expected: 0 },
    { name: "own text cut", content: "Readable text extending past the clipping box", expected: 1 },
    { name: "descendant cut", content: '<span style="display:inline-block;width:140px">Readable text</span>', expected: 1 },
    { name: "control cut", content: '<button style="width:140px"><svg width="120" height="10" aria-label="Icon"></svg>Action</button>', expected: 1 },
    { name: "intentional ellipsis", css: '#clip{text-overflow:ellipsis}', content: "Readable text extending past the clipping box", expected: 0 },
  ];
  await page.expression(`(()=>{const frame=document.createElement('iframe');frame.id='layout-checker-fixture';
    frame.style.cssText='position:fixed;inset:0;width:400px;height:200px;z-index:2147483647';document.body.append(frame)})()`);
  try {
    for (const cell of cases) {
      const html = `<style>body{margin:20px}#clip{position:relative;width:100px;overflow:hidden;white-space:nowrap;font:10px monospace}${cell.css ?? ""}</style><div id="clip">${cell.content}</div>`;
      const actual = await page.expression<ReturnType<typeof measureLayout>>(`(()=>{const doc=document.querySelector('#layout-checker-fixture').contentDocument;
        doc.open();doc.write(${JSON.stringify(html)});doc.close();return doc.defaultView.eval(${JSON.stringify(`(${measureLayout.toString()})((${visibleClipping.toString()})())`)})})()`);
      assert.equal(actual.clipped.length, cell.expected, cell.name);
    }
    console.log(JSON.stringify({ layoutClippingCheckerCases: cases.length, result: "PASS" }));
  } finally { await page.expression("document.querySelector('#layout-checker-fixture').remove()"); }
}
async function click(page: Page, name: string, scope = 'button,[role="button"]') {
  await page.expression(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(scope)})].find(e=>(e.getAttribute('aria-label')||e.textContent)?.trim()===${JSON.stringify(name)});n?.scrollIntoView({block:'nearest'})})()`);
  await until(() => page.expression<boolean>(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(e=>{
    if((e.getAttribute('aria-label')||e.textContent)?.trim()!==${JSON.stringify(name)})return false;
    const r=e.getBoundingClientRect();if(!r.width||!r.height||!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))return false;
    for(let p=e;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'&&a.timeline instanceof DocumentTimeline&&a.effect?.getComputedTiming().iterations!==Infinity))return false;
    return true;
  })`), Boolean, `hit-testable control ${name}`);
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
async function cardRadius(page: Page, factor: number): Promise<number> {
  await page.expression(`(()=>{const frame=document.createElement('iframe');frame.id='radius-sample';
    frame.style.cssText='position:fixed;inset:0;width:800px;height:600px;border:0;z-index:2147483647';
    frame.src='app://butler/index.html?visual=design-system&page=components/Card';document.body.append(frame);})()`);
  try {
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('#radius-sample')?.contentDocument?.querySelector('[data-slot="card"]')));
    return await page.expression(`(()=>{const doc=document.querySelector('#radius-sample').contentDocument;
      doc.documentElement.style.setProperty('--ui-scale','${factor}');
      return parseFloat(doc.defaultView.getComputedStyle(doc.querySelector('[data-slot="card"]')).borderTopLeftRadius)*${factor};})()`);
  } finally { await page.expression("document.querySelector('#radius-sample').remove()"); }
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
async function shortcut(main: TextSizeMain, role: string, contents = `${win}.webContents`, alias = "") {
  await main.evaluate(`(()=>{
    const {Menu}=${electron};
    const find=menu=>menu?.items.flatMap(item=>[item,...(item.submenu?find(item.submenu):[])] )??[];
    const items=find(Menu.getApplicationMenu()??globalThis.textSizeNativeMenu);
    const item=items.find(item=>item.id===${JSON.stringify(`text-size-${role}${alias}`)})??items.find(item=>item.role===${JSON.stringify(role)});
    if(!item)throw new Error('Missing zoom accelerator: '+${JSON.stringify(role)});
    ${contents}.focus();item.click({},${win},${contents});
  })()`);
  // A native view can be occluded (including by the lock screen). Its animation
  // frames need not run; callers assert the observable zoom/settings instead.
}
async function assertSize(page: Page, main: TextSizeMain, size: "default" | "large" | "larger", label: string) {
  const factor = textSizeFactor(size);
  await until(() => server.api<{text_size:string}>("/settings"), settings => settings.text_size === size, `persisted text size ${size}`);
  await until(() => main.evaluate(`${win}.webContents.getZoomFactor()`), zoom => zoom === factor, `accelerator zoom ${factor}`);
  assert.equal(await page.expression("Number(document.documentElement.style.getPropertyValue('--ui-scale'))"), factor);
  assert.equal(await page.expression(`document.querySelector('[data-setting-id="text-size"] [aria-checked="true"]')?.textContent?.trim()`), label);
  console.log(JSON.stringify({ acceleratorSize: size, zoom: factor, scale: factor, selectedLabel: label }));
}
async function inputShortcuts(page: Page, main: TextSizeMain) {
  const cases = [
    [{ key: "0", code: "Digit0" }, "reset", "default", copy.settings.options.textSizeDefault],
    [{ key: "=", code: "Equal" }, "increase", "large", copy.settings.options.textSizeLarge],
    [{ key: "+", code: "Equal", shift: true }, "increase", "larger", copy.settings.options.textSizeLarger],
    [{ key: "+", code: "NumpadAdd" }, "increase", "larger", copy.settings.options.textSizeLarger],
    [{ key: "-", code: "Minus" }, "decrease", "large", copy.settings.options.textSizeLarge],
    [{ key: "-", code: "NumpadSubtract" }, "decrease", "default", copy.settings.options.textSizeDefault],
    [{ key: "+", code: "Equal" }, "increase", "large", copy.settings.options.textSizeLarge],
    [{ key: "0", code: "Numpad0" }, "reset", "default", copy.settings.options.textSizeDefault],
    [{ key: "Insert", code: "Numpad0" }, "reset", "default", copy.settings.options.textSizeDefault],
  ] as const;
  for (const platform of ["win32", "linux"]) {
    for (const [key, command, size, label] of cases) {
      const input = { type: "keyDown", control: true, ...key };
      const mapped = await main.evaluate(`(()=>{
        const {textSizeShortcut}=${module}(${JSON.stringify(join(electronRoot, "butler-platform/text-size.mjs"))});
        const {dispatchTextSizeCommand}=${module}(${JSON.stringify(join(electronRoot, "text-size.mjs"))});
        const command=textSizeShortcut(${JSON.stringify(input)},${JSON.stringify(platform)});
        if(command && !dispatchTextSizeCommand(${win}.webContents,command))throw new Error('App shortcut rejected');
        return command;
      })()`);
      assert.equal(mapped, command, `${platform}: ${JSON.stringify(input)}`);
      await assertSize(page, main, size, label);
    }
  }
  const ignored = await main.evaluate(`(()=>{
    const {textSizeShortcut}=${module}(${JSON.stringify(join(electronRoot, "butler-platform/text-size.mjs"))});
    const input={type:'keyDown',control:true,key:'=',code:'Equal'};
    return [textSizeShortcut(input,'darwin'), ...[
      {type:'keyUp'},{control:false},{alt:true},{meta:true},{key:'a',code:'KeyA'},
    ].map(override=>textSizeShortcut({...input,...override},'linux'))].every(command=>command===undefined);
  })()`);
  assert(ignored, "macOS, key-up, unrelated keys and other modifiers do not dispatch Ctrl zoom");
  console.log(JSON.stringify({ syntheticInputShortcuts: cases.length * 2, platforms: ["win32", "linux"], ignoredInputs: 6 }));
}
async function gestures(main: TextSizeMain, contents: string) {
  await main.evaluate(`(async()=>{
    const wc=${contents};
    const point=await wc.executeJavaScript('({x:innerWidth/2,y:innerHeight/2})');
    wc.debugger.attach('1.3');
    try {
      for(const modifiers of [2,4]) await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:-120,deltaX:0,modifiers});
      await wc.debugger.sendCommand('Input.synthesizePinchGesture',{...point,scaleFactor:1.5,gestureSourceType:'touch'});
      return await wc.debugger.sendCommand('Runtime.evaluate',{expression:'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(visualViewport.scale))))',awaitPromise:true,returnByValue:true});
    }finally{wc.debugger.detach();}
  })()`).then(result => assert.equal((result as {result:{value:number}}).result.value, 1, 'pinch visual zoom stays at 1'));
}
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Local page</title><p>Independent browser zoom</p>", { headers: { "content-type": "text/html" } }) });
let app: Awaited<ReturnType<typeof launch>> | undefined;
try {
  await server.api('/settings', { method: 'PATCH', body: JSON.stringify({ text_size: 'larger' }) });
  app = await launch();
  console.log("startup App connected");
  const first = await until(() => Promise.resolve(app!.readFirstPaints()),
    entries => entries.some(entry => entry.url.startsWith('app://butler/')), 'first ready-to-show');
  writeFileSync(join(evidence, 'first-paints.json'), JSON.stringify(first, null, 2));
  assert(first.some(entry => entry.url.startsWith('app://butler/') && entry.zoom === 1.3), `first ready-to-show already uses 1.3: ${JSON.stringify(first)}`);
  console.log("ready-to-show recorded", JSON.stringify(first));
  console.log("frame probe", await app.page.expression('({scheduled:window.textSizeFrameScheduled,frame:window.textSizeFirstFrame,visibility:document.visibilityState,root:document.querySelector("#root")?.childElementCount})'));
  await app.page.waitForFunction(() => Boolean((window as Window & {textSizeFirstFrame?: unknown}).textSizeFirstFrame));
  const firstFrame = await app.page.expression<{scale:string}>('window.textSizeFirstFrame');
  assert.equal(Number(firstFrame.scale), textSizeFactor("larger"), "first rendered frame uses startup scale");
  console.log(JSON.stringify({ firstFrame, firstPaint: first, evidence, conditions: { electronArgs: smokeElectronArgs(), displayLock: process.env.BUTLER_SMOKE_SCREEN_LOCKED ?? 'unknown' } }));
  await app.stop(); app = undefined;
  await server.api('/settings' , { method: 'PATCH', body: JSON.stringify({ language: 'ko', text_size: 'default', appearance_theme: 'light', reduce_motion: true }) });
  for (let index = 0; index < 30; index++) await server.api('/sessions', {method:'POST', body:JSON.stringify({kind:'chat',title:`큰 글자 검증 대화 ${index + 1}`})});
  app = await launch();
  const { page, main } = app;

  console.log("default App connected");
  const baseline = { ...await radii(page, 1), card: await cardRadius(page, 1) };
  await appearance(page);

  const origin = await page.expression('window.textSizeDocumentMarker = Math.random()');
  await inputShortcuts(page, main);
  for (const [label, factor] of [[copy.settings.options.textSizeLarge, textSizeFactor("large")], [copy.settings.options.textSizeLarger, textSizeFactor("larger")]] as const) {
    await change(page, label, factor);
    await until(() => main.evaluate<number>(`${win}.webContents.getZoomFactor()`), value => value === factor, 'native zoom');
    assert.equal(await page.expression('window.textSizeDocumentMarker'), origin, 'setting applies without reload');
    await click(page, copy.settings.back);
    const values = { ...await radii(page, factor), card: await cardRadius(page, factor) };
    for (const selector of Object.keys(baseline)) assert(Math.abs(values[selector as keyof typeof values]! - baseline[selector as keyof typeof baseline]!) <= 0.5, `${selector}: radius changed`);
    console.log(JSON.stringify({ factor, radiiDip: values }));
    await appearance(page);
  }
  await change(page, copy.settings.options.textSizeLarge, 1.15);
  await assertSize(page, main, "large", copy.settings.options.textSizeLarge);
  writeFileSync(join(evidence, "sidebar-before-shortcut.png"), await page.screenshot());
  console.log("zoom accelerator baseline", await main.evaluate(`({zoom:${win}.webContents.getZoomFactor(),menu:${electron}.Menu.getApplicationMenu()?.items.map(x=>x.role)??null,vibrancy:${win}.getVibrancy?.(),background:${win}.getBackgroundColor()})`));
  await shortcut(main, "zoomin");
  console.log("zoom accelerator first result", await main.evaluate(`${win}.webContents.getZoomFactor()`));
  await assertSize(page, main, "larger", copy.settings.options.textSizeLarger);
  await shortcut(main, "zoomin", `${win}.webContents`, "-equal");
  await assertSize(page, main, "larger", copy.settings.options.textSizeLarger);
  await main.evaluate(`(async()=>{
    const {createLifecycleWindow}=${module}(${JSON.stringify(join(electronRoot, "lifecycle-window.mjs"))});
    globalThis.textSizeLifecycle=createLifecycleWindow({BrowserWindow:${electron}.BrowserWindow,kind:'startup'});
    return true;
  })()`);
  const lifecycle = "globalThis.textSizeLifecycle.window.webContents";
  await until(() => main.evaluate<boolean>(`${lifecycle}.getURL().includes('lifecycle.html') && !${lifecycle}.isLoading()`), Boolean, 'lifecycle loaded');
  await gestures(main, lifecycle);
  assert.equal(await main.evaluate(`${lifecycle}.getZoomFactor()`), 1.3);
  await shortcut(main, "zoomout", lifecycle);
  await assertSize(page, main, "large", copy.settings.options.textSizeLarge);
  assert.equal(await main.evaluate(`${lifecycle}.getZoomFactor()`), 1.15, 'lifecycle follows the setting');
  await main.evaluate('globalThis.textSizeLifecycle.destroy()');
  await main.evaluate(`${win}.focus();${win}.webContents.focus()`);
  await shortcut(main, "zoomout");
  await assertSize(page, main, "default", copy.settings.options.textSizeDefault);
  await shortcut(main, "zoomout");
  await assertSize(page, main, "default", copy.settings.options.textSizeDefault);
  await change(page, copy.settings.options.textSizeLarger, 1.3);
  await assertSize(page, main, "larger", copy.settings.options.textSizeLarger);
  await shortcut(main, "resetzoom");
  await assertSize(page, main, "default", copy.settings.options.textSizeDefault);
  await change(page, copy.settings.options.textSizeLarger, 1.3);
  await assertSize(page, main, "larger", copy.settings.options.textSizeLarger);
  await gestures(main, `${win}.webContents`);
  await assertSize(page, main, "larger", copy.settings.options.textSizeLarger);
  writeFileSync(join(evidence, "sidebar-branch.png"), await page.screenshot());
  await main.evaluate(`(()=>{const {WebContentsView}=${electron};
    globalThis.zoomProbe=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    void globalThis.zoomProbe.webContents.loadURL('app://butler/browser-overlay.html');})()`);
  await until(() => main.evaluate<boolean>("globalThis.zoomProbe.webContents.getURL().endsWith('browser-overlay.html') && !globalThis.zoomProbe.webContents.isLoading()"), Boolean, 'same session overlay probe');
  const inheritedZoom = await main.evaluate<number>('globalThis.zoomProbe.webContents.getZoomFactor()');
  console.log(JSON.stringify({ sameSessionOverlayZoom: inheritedZoom, expectedDipZoom: 1 }));
  assert.equal(inheritedZoom, textSizeFactor("larger"), 'same origin overlay inherits App zoom without session isolation');
  await main.evaluate('globalThis.zoomProbe.webContents.close()');
  await layout(page, 'appearance-130');
  await click(page, copy.settings.back);
  await layout(page, 'new-chat-130');
  await click(page, copy.space.recent, '[role="radio"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="app-sidebar"] [data-tree-item]')].length >= 30);
  await layout(page, 'many-sidebar-items-130');
  await click(page, copy.space.all, '[role="radio"]');
  await page.clickSelector('[data-slot="composer-compact-preview"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('contenteditable') === 'true');
  await page.insertText('긴 답변을 보여 주세요.');
  await page.clickSelector('[data-test-class="composer-send-button"]');
  await page.waitForFunction(() => document.body.textContent?.includes('30번째 문단: 읽기 쉬운 긴 답변입니다.'));
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
  const agentId = await page.expression<string>(`window.butlerBrowser.call('create',{owner:'conversation:general',agent:true,url:${JSON.stringify(new URL('__o/fixture', site.url).href)},policy:{content_origin:${JSON.stringify(site.url.origin)}}})`);
  const agent = `globalThis.textSizeBrowser.tabs.get(${JSON.stringify(agentId)})`;
  await main.evaluate(`${agent}.identityReady.then(async()=>{await ${agent}.view.webContents.loadURL(${JSON.stringify(new URL('__o/fixture', site.url).href)});return true})`);
  await until(() => main.evaluate<boolean>(`Boolean(${agent}.view && ${agent}.loaded)`), Boolean, 'agent page loaded');
  await main.evaluate('globalThis.textSizeBrowser.pointer.create()');
  await until(() => main.evaluate<boolean>('globalThis.textSizeBrowser.pointer.ready === true'), Boolean, 'isolated overlay loaded');
  assert.equal(await main.evaluate('globalThis.textSizeBrowser.pointer.view.webContents.getZoomFactor()'), 1, 'isolated overlay uses DIP coordinates');
  await main.evaluate(`globalThis.textSizeBrowser.activate(${JSON.stringify(tabId)})`);
  await until(() => main.evaluate<boolean>(`${agent}.bounds.visible === false && ${agent}.bounds.scale === 1`), Boolean, 'agent parked at its own scale');
  const agentScale = await main.evaluate<number>(`${agent}.bounds.scale`);
  assert.equal(await main.evaluate(`${webContents}.getZoomFactor()`), 1, 'page starts at its own zoom 1');
  const frameProbe = await main.evaluate(`(async()=>{const wc=${webContents};
    await wc.executeJavaScript('globalThis.smokeFrameFired=false;requestAnimationFrame(()=>globalThis.smokeFrameFired=true);true');
    await new Promise(done=>setTimeout(done,150));
    return {mainTimerFired:true,destroyed:wc.isDestroyed(),loading:wc.isLoading(),renderer:await wc.executeJavaScript('({visibility:document.visibilityState,frameFired:globalThis.smokeFrameFired,ready:document.readyState})')};})()`);
  console.log(JSON.stringify({occludedBrowserFrameProbe:frameProbe}));
  await shortcut(main, "zoomin", webContents);
  assert(Math.abs(await main.evaluate<number>(`${webContents}.getZoomFactor()`) - Math.sqrt(1.2)) < 0.001, 'browser menu keeps normal Electron zoom step');
  assert.equal(await main.evaluate(`${win}.webContents.getZoomFactor()`), 1.3, 'browser shortcut leaves App size unchanged');
  await shortcut(main, "resetzoom", webContents);
  assert.equal(await main.evaluate(`${webContents}.getZoomFactor()`), 1);
  for (const [size, factor] of (['default','large','larger'] as const).map(size => [size, textSizeFactor(size)] as const)) {
    await page.expression(`window.butlerApp.setTextSize(${JSON.stringify(size)})`);
    assert.equal(await main.evaluate(`${webContents}.getZoomFactor()`), 1, "web page keeps its own zoom");
    // Probe the real native window, observing the rendered layout at every step.
    // Binary search uses measured content sizes; no factor-derived boundary.
    let low = 500, high = 1000;
    while (high - low > 1) {
      const width = Math.floor((low + high) / 2);
      await main.evaluate(`${win}.setContentSize(${width},800)`);
      await until(() => page.evaluate(() => innerWidth), value => Math.abs(value * factor - width) <= 1, 'native resize rendered');
      const compact = await page.evaluate(() => new Promise<boolean>(done => requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelector('[data-panel-layout]')?.getAttribute('data-panel-layout') === 'drawer')))));
      if (compact) low = width; else high = width;
    }
    await main.evaluate(`${win}.setContentSize(${low},800)`);
    await page.waitForFunction(() => document.querySelector('[data-panel-layout]')?.getAttribute('data-panel-layout') === 'drawer');
    const compactThroughDip = await main.evaluate(`${win}.getContentSize()[0]`);
    const agentState = await main.evaluate<{ zoom: number; scale: number; width: number; logicalWidth: number }>(`(async()=>{const t=${agent};return {zoom:t.view.webContents.getZoomFactor(),scale:t.bounds.scale,width:t.bounds.width,logicalWidth:await t.view.webContents.executeJavaScript('innerWidth')}})()`);
    assert.equal(agentState.scale, agentScale, 'parked agent presentation scale is unchanged');
    assert.equal(agentState.zoom, 1, 'agent page zoom is independent');
    assert.equal(agentState.logicalWidth, 1280, 'agent logical viewport is unchanged');
    if (await main.evaluate<boolean>(`${agent}.bounds.visible`)) assert(Math.abs(agentState.scale - agentState.width / 1280) < 0.01, 'agent presentation scale follows native bounds');
    await main.evaluate(`${win}.setContentSize(${high},800)`);
    await page.waitForFunction(() => document.querySelector('[data-panel-layout]')?.getAttribute('data-panel-layout') === 'docked');
    console.log(JSON.stringify({ factor, compactThroughDip, expandedFromDip: high, agent: agentState }));
  }
  await main.evaluate(`${win}.setContentSize(1280,800)`);
  await click(page, copy.browser.title);
  await click(page, copy.sidebar.newChat);
  await checkSuggestionStrips(page, main, win, evidence);
  await verifyVisibleClipping(page);
  await verifyLayoutClipping(page);
  await textSizeSweep({ page, main, win, evidence, click, server });
  await appearance(page);
  await change(page, copy.settings.options.textSizeDefault, textSizeFactor("default"));
  await until(() => main.evaluate<number>(`${win}.webContents.getZoomFactor()`), value => value === 1, 'back to default native zoom');
  assert.equal(await page.expression('window.textSizeDocumentMarker'), origin, 'default also preserves the document');
  assert.deepEqual(layoutFailures, [], 'all required screens have no clipped non-ellipsis text');

} finally { await app?.stop(); await server.stop(); await site.stop(true); }
