/** Isolated real App driver; main inspector is the existing smoke seam. */
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronPage } from "./electron-page-cdp";
import { connectElectronMain } from "./electron-main-cdp";
import { createNativeAppServer, freePort, type StubModelRequest } from "./native-app-server";
import { smokeElectronArgs } from "./smoke-browser";

export async function waitBrowser(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
export async function browserAgentApp(evidence: string, stubToolCall: (request: StubModelRequest) => { name: string; arguments: Record<string, unknown> } | null, rendererDist?: string) {
  mkdirSync(evidence,{recursive:true});
  const dir = mkdtempSync(join(tmpdir(), "browser-agent-app-"));
  const home = join(dir, "home"); mkdirSync(home); mkdirSync(join(dir, "profile"));
  const gateway = await createNativeAppServer({ stubToolCall, uiRoot: rendererDist });
  const inspector = await freePort(), debug = await freePort();
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
  assert.ok(executable, "explicit Electron 44 executable required");
  const child = spawn(executable, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), resolve("packages/butler-app/client/electron")], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: gateway.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_UI_URL: "", BUTLER_APP_RENDERER_DIST: rendererDist ?? resolve("packages/butler-app/client/ui/dist"),
      BUTLER_APP_SERVER_URL: gateway.url, BUTLER_APP_SERVER_PORT: String(gateway.port), BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub" },
  });
  const logs: string[] = [];
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", bytes => logs.push(String(bytes).replace(/(__o\/)[^/\s]+/gu, "$1[redacted]")));
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  const win = `${module}('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'))`;
  let inspectorClient: ReturnType<typeof connectElectronMain> | undefined;
  const main = async <T>(expression: string): Promise<T> => {
    inspectorClient ??= connectElectronMain(inspector);
    return (await inspectorClient).evaluate<T>(expression);
  };
  let page: Awaited<ReturnType<typeof electronPage>> | undefined;
  const stop = async () => {
    page?.close();
    (await inspectorClient?.catch(()=>undefined))?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const until=Date.now()+5000;
      while(Date.now()<until && child.exitCode===null && child.signalCode===null) await new Promise(done=>setTimeout(done,100));
      if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");
    }
    writeFileSync(join(evidence,"agent.log"),gateway.diagnostics());
    await gateway.stop(); writeFileSync(join(evidence, "electron.log"), logs.join("")); rmSync(dir, { recursive: true, force: true });
  };
  try {
    page = await electronPage(debug);
    await main(`${win}.setContentSize(1440,900)`);
    await main(`(() => { ${win}.show();${win}.focus();${win}.webContents.focus(); })()`);
    const versions = await main<Record<string, string>>("process.versions");
    assert.match(versions.electron!, /^44\./u);
    writeFileSync(join(evidence, "electron-versions.json"), JSON.stringify(versions, null, 2));
    await main(`(() => { const make=${module}(${JSON.stringify(resolve("packages/butler-app/client/electron/browser/tabs.mjs"))}).createUserBrowser;
      const dummy=make({getPath:()=>${JSON.stringify(dir)},on:()=>{}},()=>null); const proto=Object.getPrototypeOf(dummy); const publish=proto.publish; const execute=proto.execute;
      const snapshot=proto.snapshot;proto.snapshot=function(){globalThis.browserAgentSubject=this;return snapshot.call(this)};
      proto.execute=async function(frame){try{return await execute.call(this,frame)}catch(error){globalThis.browserAgentError=String(error.stack);throw error}};
      proto.publish=function(){globalThis.browserAgentSubject=this;return publish.call(this)};
    })()`);
    const call = async <T>(op: string, input: unknown = {}) => page!.expression<T>(`window.butlerBrowser.call(${JSON.stringify(op)},${JSON.stringify(input)})`);
    const shot = async (name: string) => {
      await page!.movePointer(900, 24);
      await waitBrowser(()=>page!.expression("!document.querySelector('[data-slot=tooltip-content]')"), "tooltip closed before screenshot");
      await page!.evaluate(() => new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
      await main(`(async()=>{const browser=globalThis.browserAgentSubject;const tab=browser?.tabs.get(browser.activeId);if(tab?.view && !tab.view.webContents.isDestroyed() && tab.attached===${win})await tab.view.webContents.executeJavaScript("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))")})()`);
      await page!.expression("Promise.all([...document.querySelectorAll('[data-test-class=browser-step-still] img')].map(img=>img.decode()))");
      const facts=await main(`(async()=>{${module}('electron').app.focus({steal:true});${win}.show();${win}.focus();${win}.moveTop();const browser=globalThis.browserAgentSubject;const tab=browser?.tabs.get(browser.activeId);let nativePixels;if(tab?.view && tab.attached===${win}) {const image=await tab.view.webContents.capturePage(undefined,{stayHidden:true});const pixels=image.getBitmap();let blue=0;for(let n=0;n<pixels.length;n+=4)if(pixels[n]>180 && pixels[n+1]<150 && pixels[n+2]<120)blue++;nativePixels={size:image.getSize(),blue};process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(evidence,`${name}-native.png`))},image.toPNG());}await ${win}.webContents.capturePage();return {nativePixels,focused:${win}.isFocused(),native:tab?.view?await tab.view.webContents.executeJavaScript("({text:document.body.innerText,scroll:[scrollX,scrollY],width:innerWidth,height:innerHeight})"):null,attached:tab?.attached===${win},covered:tab?.covered,nativeCovers:browser?.nativeCovers,bounds:tab?.bounds}})()`);
      writeFileSync(join(evidence,`${name}-capture.json`),JSON.stringify(facts));
      const capture = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE; assert.ok(capture);
      const source = await main<string>(`${win}.getMediaSourceId()`);
      writeFileSync(join(evidence, `${name}-renderer.png`), await page!.screenshot());
      const result = Bun.spawnSync([capture, source.split(":")[1]!, join(evidence, `${name}.png`)]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      const compositor=await main<{blue:number}>(`(()=>{const t=globalThis.browserAgentSubject?.tabs.get(globalThis.browserAgentSubject.activeId);const png=${module}('electron').nativeImage.createFromPath(${JSON.stringify(join(evidence,`${name}.png`))});const size=png.getSize(),b=png.getBitmap(),bounds=t?.bounds;let blue=0;if(bounds)for(let y=Math.ceil(bounds.y*size.width/1440);y<(bounds.y+bounds.height)*size.width/1440;y++)for(let x=Math.ceil(bounds.x*size.width/1440);x<(bounds.x+bounds.width)*size.width/1440;x++){const n=(y*size.width+x)*4;if(b[n]>180 && b[n+1]<150 && b[n+2]<120)blue++}return {size,blue,attached:t?.attached===${win},covered:t?.covered,holder:t?.holder,bounds}})()`);
      writeFileSync(join(evidence,`${name}-compositor.json`),JSON.stringify(compositor));
      if ((facts as {nativePixels?:{blue:number}}).nativePixels?.blue) assert.ok(compositor.blue>0,'native page is present in the complete App window screenshot');
    };
    const click = async (name: string) => {
      await main(`${win}.webContents.focus()`);
      await waitBrowser(()=>page!.expression(`(() => {
        const node=[...document.querySelectorAll('button,[role="button"]')].find(e=>(e.getAttribute('aria-label')||e.textContent)?.trim()===${JSON.stringify(name)});
        if(!node || node.disabled || node.getAttribute('aria-disabled')==='true') return false;
        for(let parent=node;parent;parent=parent.parentElement) if(parent.getAnimations().some(a=>a.playState==='running')) return false;
        return node.getBoundingClientRect().width>0;
      })()`), `button ${name}`);
      await page!.clickText(name,'button,[role="button"]');
    };
    return { gateway, page, main, win, call, shot, click, stop };
  } catch (error) {
    const state = await main(`({windows:${module}('electron').BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible()})),ready:${module}('electron').app.isReady(),lock:${module}('electron').app.hasSingleInstanceLock(),path:${module}('electron').app.getPath('userData')})`).catch(()=>null);
    writeFileSync(join(evidence,"startup-failure.json"),JSON.stringify({state,exitCode:child.exitCode,signal:child.signalCode}));
    await stop(); throw error;
  }
}
