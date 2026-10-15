// test-category: security
/** Functional identity acceptance on the production Electron tab registry. */
import { googleSigninProbe } from "../support/browser-google-probe";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { assertBrowserIdentity, identityFixture } from "../support/browser-identity-fixture";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE; assert.ok(executable);
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const fixture = identityFixture(), dir = mkdtempSync(join(tmpdir(), "browser-identity-"));
const results = join(dir, "result.json"), root = resolve("packages/butler-app/client/electron/browser");
const moduleUrl = (name: string) => pathToFileURL(join(root, `${name}.mjs`)).href;
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "butler-identity-smoke", version: "0.1.0", main: "main.mjs", type: "module" }));
writeFileSync(join(dir, "main.mjs"), `import {app,BrowserWindow,protocol,session} from 'electron';import {writeFileSync} from 'node:fs';
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.on('window-all-closed',()=>{});
console.log("entry");void app.whenReady().then(async()=>{try{console.log("ready");
 session.defaultSession.protocol.handle('app',()=>new Response('<title>Butler internal shell</title>'));const {createUserBrowser}=await import(${JSON.stringify(moduleUrl("tabs"))});
 const shell=new BrowserWindow({show:true,width:1280,height:800,webPreferences:{sandbox:true}});
 console.log('shell');await shell.loadURL('app://butler/');
 console.log('shell loaded');const internal=await shell.webContents.executeJavaScript('navigator.userAgent');
 const b=createUserBrowser(app,()=>shell);const out={internal,versions:process.versions};
 const read=async(tab)=>{await Promise.race([tab.identityReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('identity not ready')),10000))]);const wc=tab.view.webContents;console.log("identity ready",tab.id,wc.getURL(),wc.isLoading());
   if(wc.isLoading()||wc.getURL()!==${JSON.stringify(fixture.url)})await new Promise(resolve=>wc.once('did-finish-load',resolve));
   return await wc.executeJavaScript("new Promise((resolve,reject)=>{if(globalThis.reports?.worker&&globalThis.reports?.iframe)return resolve(reports);const timer=setTimeout(()=>reject(Error('fixture not complete')),10000);addEventListener('identity-ready',()=>{clearTimeout(timer);resolve(reports)},{once:true})})")};
 await b.open();const id=b.create({url:${JSON.stringify(fixture.url)},profile:'signed_out'});const tab=b.tabs.get(id);shell.contentView.addChildView(tab.view);tab.view.setBounds({x:0,y:0,width:1280,height:800});
 console.log('tab created');out.app=await read(tab);console.log('tab read');writeFileSync(${JSON.stringify(join(evidence, "electron-identity-partial.json"))},JSON.stringify(out));out.internalAfter=await shell.webContents.executeJavaScript('navigator.userAgent');
 // Real popup uses the production createWindow callback and retains its opener.
 tab.popupGesture=true;tab.popupGestureAt=Date.now();await tab.view.webContents.executeJavaScript("window.open("+JSON.stringify(${JSON.stringify(fixture.url)})+",'_blank');true",true);
 await new Promise(r=>setTimeout(r,200));const popup=[...b.tabs.values()].find(t=>t.opener===id);if(!popup)throw Error('popup missing');out.popup=await read(popup);console.log("popup read");
 b.close(popup.id);b.close(id);shell.hide();
 const hidden=createUserBrowser(app,()=>null);const hid=hidden.create({url:${JSON.stringify(fixture.url)},profile:'signed_out'});const ht=hidden.tabs.get(hid);const background=new BrowserWindow({show:false});background.contentView.addChildView(ht.view);ht.view.setBounds({x:0,y:0,width:1280,height:800});ht.view.webContents.setBackgroundThrottling(false);
 out.hidden=await read(ht);console.log("hidden read");hidden.close(hid);background.destroy();
 const {renderReader}=await import(${JSON.stringify(moduleUrl("reader-render"))});
 out.reader=await renderReader({url:${JSON.stringify(fixture.url + "?no-frame")},policy:{content_origin:${JSON.stringify(fixture.server.url.origin.replace("0.0.0.0", "127.0.0.1"))}}});
 ${process.env.BUTLER_UA_GOOGLE_CHECK === "1" ? `shell.show();const gid=b.create({url:'https://accounts.google.com/signin',profile:'signed_out'});const gt=b.tabs.get(gid);shell.contentView.addChildView(gt.view);gt.view.setBounds({x:0,y:0,width:1280,height:800});await gt.identityReady;
 out.google=await (${googleSigninProbe.toString()})(gt.view.webContents);
 writeFileSync(${JSON.stringify(join(evidence, "google-signin.png"))},(await gt.view.webContents.capturePage()).toPNG());b.close(gid);` : ""}
 writeFileSync(${JSON.stringify(results)},JSON.stringify(out));shell.destroy();app.exit(0);
}catch(error){writeFileSync(${JSON.stringify(results)},JSON.stringify({error:String(error.stack)}));app.exit(1)}});`);
let logs = "";
const env = { ...process.env };
  env.BUTLER_APP_ELECTRON_USER_DATA_DIR = join(dir, "profile"); delete env.ELECTRON_RUN_AS_NODE;
// As the windowless browser host runs: hidden and occluded test windows must
// not have their renderers deprioritized by the OS (see browser-host.mjs).
const child = spawnElectron(executable, ["--disable-renderer-backgrounding", dir], { env, onOutput: bytes => { logs += String(bytes); } });
try {
  // The harness owns process termination after the functional result is ready.
  await new Promise<void>((done, fail) => {
    const cleanup = () => { clearTimeout(timer); watcher.close(); };
    const check = () => { if (existsSync(results)) { cleanup(); done(); } };
    const watcher = watch(dir, check);
    const timer = setTimeout(() => { cleanup(); fail(new Error("identity smoke timeout")); }, 90_000);
    child.once("exit", () => { cleanup(); if (existsSync(results)) done(); else fail(new Error("identity child exited without result")); });
    check();
  });
  const out = JSON.parse(readFileSync(results, "utf8"));
  writeFileSync(join(evidence, "electron-identity.json"), JSON.stringify({ ...out, requests: fixture.requests }, null, 2));
  assert.ok(!out.error, out.error); assert.equal(out.internal, out.internalAfter); assert.match(out.internal, /Electron\//u);
  for (const backend of ["app", "hidden", "popup"]) assertBrowserIdentity(out[backend], out.versions.chrome, fixture.requests);
  assert.equal(out.reader.status, "ok");
  const reader = Buffer.from(out.reader.html_base64, "base64").toString("utf8"); assert.ok(reader.includes('"worker"'));
  if (out.google) { assert.equal(out.google.outcome, "account_not_found", `Google probe: ${out.google.outcome}`); }
  console.log(JSON.stringify({ ok: true, version: out.versions.chrome, brands: out.app.page.js.data.brands, google: out.google }));
} finally {
  await stopElectronChild(child); writeFileSync(join(evidence, "electron-identity.log"), logs);
  fixture.server.stop(true); rmSync(dir, { recursive: true, force: true });
}
