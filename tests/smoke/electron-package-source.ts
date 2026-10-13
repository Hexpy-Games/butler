// test-category: format-pin
/** Load the release-staged shell, including its browser menu imports. */
import { strict as assert } from "node:assert";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stageElectronPackageSource } from "../../packages/butler-app/scripts/release/electron-package-source.ts";
import { spawnElectron, stopElectronChild } from "../support/electron-child.ts";
import { smokeElectronArgs } from "../support/smoke-browser.ts";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert.ok(evidence && executable, "explicit evidence directory and Electron executable required");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "electron-package-source-"));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
let child: ReturnType<typeof spawnElectron> | undefined;
let log = "";
try {
  const source = stageElectronPackageSource(process.cwd(), join(dir, "source"));
  assert.ok(existsSync(join(source, "i18n/native-context-menu.mjs")));
  assert.equal(existsSync(join(source, "butler-platform/link-menu-smoke-capture.mjs")), false);
  assert.equal(existsSync(join(source, "butler-platform/link-menu-smoke-windows.swift")), false);
  const font = resolve("packages/butler-app/client/ui/src/libs/design-system/fonts/ibm-plex-mono/IBMPlexMono-Regular-Latin1.woff2");
  const subsetter = pathToFileURL(join(source, "browser/snapshot-font.mjs")).href;
  const fontLog = join(evidence, "packaged-font.log"), writer = openSync(fontLog, "w");
  try {
    const code = `import {readFileSync} from 'node:fs';import {subsetSnapshotFont} from ${JSON.stringify(subsetter)};
      const bytes=await subsetSnapshotFont(readFileSync(${JSON.stringify(font)}),'Office ffi 123');console.log(bytes.length)`;
    const script = join(dir, "font-smoke.mjs"); writeFileSync(script, code);
    const result = spawnSync(executable, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", writer, writer], timeout: 30_000,
    });
    assert.equal(result.status, 0, readFileSync(fontLog, "utf8"));
    const bytes = Number(readFileSync(fontLog, "utf8").trim());
    assert.ok(bytes > 0 && bytes < readFileSync(font).length, "staged worker and font dependencies produce a subset");
  } finally { closeSync(writer); }
  const home = join(dir, "home"); mkdirSync(home);
  const data = join(dir, "data"); mkdirSync(data);
  const profile = join(dir, "profile"); mkdirSync(profile);
  child = spawnElectron(executable, [...smokeElectronArgs(), source], {
    onOutput: bytes => { log += String(bytes); },
    env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: data,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
      BUTLER_APP_SERVER_URL: server.url.href, BUTLER_APP_SERVER_PORT: String(server.port),
      BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"), BUTLER_E2E_TIER: "stub" },
  });
  const deadline = Date.now() + 30_000;
  while (!log.includes('"stage":"runtime_imported"') && Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Electron exited before loading main");
    assert.equal(child.signalCode, null, "Electron terminated before loading main");
    await Bun.sleep(100);
  }
  assert.ok(log.includes('"stage":"runtime_imported"'), "staged main process did not load");
  assert.ok(!log.includes("ERR_MODULE_NOT_FOUND"), "unpackaged module import");
  writeFileSync(join(evidence, "packaged-layout.json"), JSON.stringify({ mainLoaded: true, pid: child.pid, menuCopyPackaged: true, smokeHelpersPackaged: false }, null, 2));
  console.log("PASS release-staged Electron main loaded; menu copy included; smoke helpers excluded");
} finally {
  if (child) await stopElectronChild(child);
  writeFileSync(join(evidence, "packaged-layout-electron.log"), log);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
