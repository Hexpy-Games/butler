/** Real App regression: Electron's rejected IPC logger must survive closed pipes. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { connectElectronMain } from "../support/electron-main-cdp";
import { electronPage } from "../support/electron-page-cdp";
import { stopElectronChild, trackElectronChild } from "../support/electron-child";
import { smokeElectronArgs } from "../support/smoke-browser";

const evidence = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert.ok(evidence, "BUTLER_SMOKE_SCREENSHOTS must name a persistent evidence directory");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "butler-epipe-"));
const server = await createNativeAppServer({ onboardingComplete: false });
const debug = await freePort(), inspector = await freePort();
const entry = resolve("packages/butler-app/client/electron");
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ?? createRequire(join(entry, "package.json"))("electron") as string;
const child = trackElectronChild(spawn(executable, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), entry], {
  // Deliberate exception to file-backed stdio: close the readers to reproduce EPIPE.
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    BUTLER_DATA: server.butlerData, BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"),
    BUTLER_APP_SERVER_URL: server.url, BUTLER_APP_SERVER_PORT: String(server.port),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub" },
}));
child.stdout!.resume(); child.stderr!.resume();
let main: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
let page: Awaited<ReturnType<typeof electronPage>> | undefined;
const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(entry, "package.json"))})('electron')`;
try {
  page = await electronPage(debug);
  main = await connectElectronMain(inspector);
  await main.evaluate(`(() => {
    globalThis.epipeDialogs=[];globalThis.epipeErrors=[];globalThis.pipeErrors=[];
    for(const [name,stream] of [['stdout',process.stdout],['stderr',process.stderr]]){
      const emit=stream.emit;stream.emit=function(event,...args){if(event==='error')pipeErrors.push({stream:name,code:args[0].code});return emit.call(this,event,...args)};
    }
    ${electron}.dialog.showErrorBox=(title,content)=>epipeDialogs.push({title,content});
    process.on('uncaughtExceptionMonitor',error=>epipeErrors.push(error.code||error.message));
    ${electron}.ipcMain.handle('epipe-smoke',()=>{throw new Error('deliberate IPC rejection')});
  })()`);
  child.stdout!.destroy(); child.stderr!.destroy();
  // Invoke from the real renderer via its main webContents. Electron itself calls
  // replyWithError -> console.error, rather than a simulated IPC implementation.
  const rejected = await main.evaluate<string>(`(async()=>{
    const win=${electron}.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'));
    const fs=process.getBuiltinModule('fs');const preload=${JSON.stringify(join(dir, "ipc.cjs"))};
    fs.writeFileSync(preload,"require('electron').ipcRenderer.invoke('epipe-smoke').catch(error=>document.title=error.message)");
    const probe=new (${electron}.BrowserWindow)({show:false,webPreferences:{preload}});
    await probe.loadURL('data:text/html,<title>IPC probe</title>');
    const end=Date.now()+5000;while(!probe.getTitle().includes('deliberate IPC rejection')&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
    const title=probe.getTitle();probe.destroy();console.log('closed stdout');return title;
  })()`);
  assert.match(rejected, /deliberate IPC rejection/u);
  // Wait for async stream error delivery, then exercise repeated writes.
  await main.evaluate("new Promise(done=>setTimeout(done,100))");
  await main.evaluate("console.error('after closed stderr');console.log('after closed stdout')");
  await main.evaluate("new Promise(done=>setTimeout(done,100))");
  const facts = await main.evaluate<{ dialogs: unknown[]; errors: string[]; pid: number; pipes: Array<{stream: string; code: string}> }>("({dialogs:epipeDialogs,errors:epipeErrors,pid:process.pid,pipes:pipeErrors})");
  writeFileSync(join(evidence, "pipe-state.json"), JSON.stringify(facts, null, 2));
  for (const stream of ["stdout", "stderr"]) {
    assert.ok(facts.pipes.some(error => error.stream === stream && error.code === "EPIPE"), `${stream} actually encountered EPIPE`);
  }
  await main.evaluate("process.stderr.emit('error',Object.assign(new Error('destroyed stream'),{code:'ERR_STREAM_DESTROYED'}))");
  await assert.rejects(main.evaluate("process.stderr.emit('error',Object.assign(new Error('unrelated IO failure'),{code:'EIO'}))"), /unrelated IO failure/u);
  assert.deepEqual(facts.dialogs, [], "no main-process error dialog");
  assert.deepEqual(facts.errors, [], "no uncaught pipe errors");
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.equal(await page.expression("document.readyState"), "complete", "App renderer still responds over CDP");
  writeFileSync(join(evidence, "app.png"), await page.screenshot());
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ...facts, rejected, responsive: true }, null, 2));
  console.log("Electron EPIPE smoke passed: 0 dialogs, 0 uncaught errors, CDP responsive");
} finally {
  page?.close(); main?.close();
  await stopElectronChild(child);
  await server.stop(); rmSync(dir, { recursive: true, force: true });
}
