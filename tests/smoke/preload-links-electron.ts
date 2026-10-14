// test-category: security
/** Actual sandboxed preload: bridge startup and DOM link interception, offline. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert.ok(executable, "explicit Electron executable required");
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence, "explicit evidence directory required");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "preload-links-"));
const result = join(dir, "result.json");
writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "main.cjs" }));
writeFileSync(join(dir, "fixture.html"), '<a id="web" href="https://example.invalid/path"><span>Web</span></a><a id="mail" href="mailto:fixture@example.invalid">Mail</a><div data-butler-link="https://example.invalid/plain"><span id="plain">Plain</span></div>');
writeFileSync(join(dir, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(dir, "profile"))});
app.whenReady().then(async () => {
  const calls = [];
  ipcMain.on('butler-app:link', (_event, ...args) => calls.push(args));
  ipcMain.handle('butler:security-request', (_event, input) => ({ ok: true, data: input }));
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: ${JSON.stringify(resolve("packages/butler-app/client/electron/preload.cjs"))}
  } });
  await win.loadFile(${JSON.stringify(join(dir, "fixture.html"))});
  const out = await win.webContents.executeJavaScript(\`(async () => {
    const dispatch = (selector, type) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: 12, clientY: 34 });
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    };
    const security = await window.butlerApp.getSecurity();
    return { security, browserBridge: typeof window.butlerBrowser.call,
      prevented: [dispatch('#web span', 'click'), dispatch('#web span', 'contextmenu'),
        dispatch('#plain', 'contextmenu'), dispatch('#mail', 'contextmenu')] };
  })()\`);
  // Round-trip IPC fences the preceding asynchronous link sends.
  await win.webContents.executeJavaScript('window.butlerApp.getSecurity()');
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ...out, calls, electron: process.versions.electron }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
const logs: string[] = [];
let child: ReturnType<typeof spawnElectron> | undefined;
try {
  const env = { ...process.env };
  env.BUTLER_APP_ELECTRON_USER_DATA_DIR = join(dir, "profile");
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawnElectron(executable, [...smokeBrowserArgs(), dir], { env, onOutput: bytes => logs.push(String(bytes)) });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Preload smoke timed out")), 30_000);
    child!.once("error", error => { clearTimeout(timer); fail(error); });
    child!.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`Electron exited ${code}, signal ${signal}`));
    });
  });
  const out = JSON.parse(readFileSync(result, "utf8"));
  assert.equal(out.electron, "44.5.1");
  assert.deepEqual(out.security, { ok: true, data: { route: "getSecurity" } });
  assert.equal(out.browserBridge, "function");
  assert.deepEqual(out.prevented, [true, true, true, false]);
  assert.deepEqual(out.calls, [
    ["open", "https://example.invalid/path", { x: 12, y: 34 }],
    ["menu", "https://example.invalid/path", { x: 12, y: 34 }],
    ["menu", "https://example.invalid/plain", { x: 12, y: 34 }],
  ]);
  writeFileSync(join(evidence, "preload-links.json"), JSON.stringify(out, null, 2));
  console.log("Sandboxed preload bridge and link smoke passed");
} finally {
  if (child) await stopElectronChild(child);
  writeFileSync(join(evidence, "preload-links-electron.log"), logs.join(""));
  rmSync(dir, { recursive: true, force: true });
}
