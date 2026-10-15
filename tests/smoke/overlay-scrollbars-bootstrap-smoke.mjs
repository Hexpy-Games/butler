// Startup contract smoke: execute the packaged entry, without a provider or UI.
// Run: node --experimental-vm-modules tests/smoke/overlay-scrollbars-bootstrap-smoke.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { configureChromiumFeatures, chromiumLaunchArgs } from "../../packages/butler-app/client/electron/butler-platform/chromium-features.mjs";

const entry = new URL("../../packages/butler-app/client/electron/bootstrap.mjs", import.meta.url);
const source = await readFile(entry, "utf8");
for (const platform of ["win32", "linux", "darwin"]) {
  await verifyBootstrap(platform);
}
for (const initial of ["", "Existing,Other:param/value", "Existing,OverlayScrollbar,Existing",
  "Existing,OverlayScrollbar:mode/value", "Existing,OverlayScrollbar<Trial"]) {
  const commandLine = switches(initial);
  configureChromiumFeatures(commandLine, "win32");
  const values = commandLine.getSwitchValue("enable-features").split(",");
  assert.equal(values.filter((value) => value.split(/[<:]/, 1)[0] === "OverlayScrollbar").length, 1);
  assert.equal(commandLine.appends, 1);
  assert.equal(commandLine.removes, 1);
  if (initial.includes("Other:param/value")) assert(values.includes("Other:param/value"));
}
console.info("PASS: packaged bootstrap ordering on Windows/Linux/macOS; five feature merge cases");
for (const platform of ["win32", "linux", "darwin"]) {
  const initial = ["--enable-features=Existing", "--enable-features=Other:param/value", "app"];
  const launched = chromiumLaunchArgs(initial, platform);
  assert.deepEqual(initial, ["--enable-features=Existing", "--enable-features=Other:param/value", "app"]);
  assert.deepEqual(launched, platform === "darwin" ? initial : ["--enable-features=Existing,Other:param/value,OverlayScrollbar", "app"]);
  assert.deepEqual(chromiumLaunchArgs(launched, platform), launched);
}

function switches(initial) {
  const values = new Map([["enable-features", initial]]);
  return {
    appends: 0, removes: 0,
    getSwitchValue(name) { return values.get(name) ?? ""; },
    removeSwitch(name) { values.delete(name); this.removes++; },
    appendSwitch(name, value) { values.set(name, value); this.appends++; },
  };
}

async function verifyBootstrap(platform) {
  const commandLine = switches("Existing");
  let ready;
  let isReady = false;
  let created = false;
  let runtimeLoaded = false;
  let quit = false;
  const events = [];
  const app = {
    commandLine, once() {}, setName() {}, setPath() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise((resolve) => { ready = resolve; }),
    quit() { quit = true; },
  };
  const context = createContext({
    process: { argv: [], env: {} },
    setImmediate(callback) { assert(created); callback(); },
  });
  const module = new SourceTextModule(source, {
    context, initializeImportMeta(meta) { meta.url = entry.href; },
    async importModuleDynamically(name) {
      assert(isReady, `${name} loaded before Chromium feature reinitialization`);
      const exports = name === "./startup-window.mjs" ? {
        async createStartupWindow() { created = true; }, failStartup: () => false,
      } : {};
      if (name === "./main.mjs") runtimeLoaded = true;
      const loaded = synthetic(exports, context);
      await loaded.link(() => {});
      await loaded.evaluate();
      return loaded;
    },
  });
  await module.link((name) => {
    assert.notEqual(name, "electron", "ESM Electron eagerly initializes nativeTheme");
    if (name === "./stdio-errors.mjs") return synthetic({}, context);
    if (name === "node:module") return synthetic({ createRequire: () => () => ({
      app, protocol: { registerSchemesAsPrivileged() {} },
    }) }, context);
    if (name.endsWith("app-renderer-protocol.mjs")) {
      return synthetic({ APP_RENDERER_SCHEME_PRIVILEGES: { scheme: "app" } }, context);
    }
    if (name.endsWith("startup-timing.mjs")) return synthetic({ startupTiming: (event) => events.push(event) }, context);
    if (name.endsWith("chromium-features.mjs")) return synthetic({
      configureChromiumFeatures: (line) => configureChromiumFeatures(line, platform),
    }, context);
    throw new Error(`Unexpected early dependency: ${name}`);
  });
  await module.evaluate();
  assert.equal(commandLine.getSwitchValue("enable-features"),
    platform === "darwin" ? "Existing" : "Existing,OverlayScrollbar");
  assert(!created);
  isReady = true;
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert(created && runtimeLoaded && !quit);
  assert.deepEqual(events, ["entry", "app_ready", "runtime_import_start", "runtime_imported"]);
}

function synthetic(exports, context) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
}
