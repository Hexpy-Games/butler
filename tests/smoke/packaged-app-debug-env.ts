// test-category: security
/** Real packaged Electron shell: environment cannot enable renderer CDP; explicit argv can. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageElectronPackageSource } from "../../packages/butler-app/scripts/release/electron-package-source.ts";
import { spawnElectron, stopElectronChild } from "../support/electron-child.ts";
import { mainInspector } from "../support/electron-main-inspector.ts";
import { freePort } from "../support/native-app-server.ts";
import { smokeElectronArgs } from "../support/smoke-browser.ts";

assert.equal(process.platform, "darwin", "This packaging smoke requires macOS");
const root = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "butler-packaged-debug-env-"));
try {
  const executable = await prepareShell();
  await check(executable, false);
  await check(executable, true);
  console.log("PASS packaged App: env-only CDP closed, explicit argv CDP available, leftover Apps: 0");
} finally { rmSync(temporary, { recursive: true, force: true }); }

async function prepareShell(): Promise<string> {
  const existing = process.env.BUTLER_DEBUG_ENV_SMOKE_BUNDLE;
  if (existing) {
    const bundle = join(temporary, "Butler.app");
    // Reuse the packaged shell, preserving this smoke's missing-Agent startup path.
    const agent = join(resolve(existing), "Contents/Resources/bundled-agent");
    cpSync(resolve(existing), bundle, { recursive: true, filter: path => path !== agent });
    return join(bundle, "Contents/MacOS/Butler");
  }
  const source = stageElectronPackageSource(root, join(temporary, "source"));
  const manifest = JSON.parse(readFileSync(resolve("packages/butler-app/client/electron/package.json"), "utf8"));
  const packager = resolve("packages/butler-app/client/electron/node_modules/@electron/packager/bin/electron-packager.mjs");
  const packaging = spawn("node", [packager, source, "Butler", "--platform=darwin", `--arch=${process.arch}`,
    `--electron-version=${manifest.devDependencies.electron}`, `--out=${temporary}`, "--overwrite", "--quiet"], { stdio: "inherit" });
  await new Promise<void>((done, fail) => {
    packaging.once("error", fail);
    packaging.once("exit", code => code === 0 ? done() : fail(new Error(`Packaging failed: ${code}`)));
  });
  const executable = join(temporary, `Butler-darwin-${process.arch}/Butler.app/Contents/MacOS/Butler`);
  cpSync(resolve("packages/butler-app/client/ui/dist"), join(temporary, `Butler-darwin-${process.arch}/Butler.app/Contents/Resources/app-client`), { recursive: true });
  return executable;
}

async function check(executable: string, explicit: boolean) {
  const port = await freePort(), inspectorPort = await freePort();
  const profile = join(temporary, explicit ? "argv" : "env");
  const child = spawnElectron(executable, [`--inspect=${inspectorPort}`, ...smokeElectronArgs(),
    ...(explicit ? [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] : [])], { env: {
    ...process.env, BUTLER_E2E_TIER: "stub", BUTLER_APP_SMOKE_DEBUG_PORT: String(port),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
    BUTLER_DATA: join(profile, "data"), BUTLER_APP_SERVER_PORT: String(await freePort()),
  } });
  let inspector: Awaited<ReturnType<typeof mainInspector>> | undefined;
  const running = () => child.exitCode === null && child.signalCode === null;
  try {
    inspector = await mainInspector(inspectorPort, running);
    // This shell intentionally has no bundled Agent. Its real startup error window must load.
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      assert.ok(running(), "Packaged App exited during startup");
      ready = await inspector.evaluate<boolean>(`(async () => {
        const {app, BrowserWindow} = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
        if (!app.isPackaged || !app.isReady()) return false;
        const windows = BrowserWindow.getAllWindows();
        return windows.length > 0 && (await Promise.all(windows.map(w =>
          w.webContents.executeJavaScript('document.readyState === "complete"')))).every(Boolean);
      })()`);
      if (!ready) await Bun.sleep(100);
    }
    assert.ok(ready, "Real packaged App window did not load");
    for (let sample = 0; sample < 20; sample++) {
      assert.ok(running(), "Packaged App must remain up during port checks");
      if (explicit) {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        assert.equal(response.ok, true);
        assert.ok((await response.json()).webSocketDebuggerUrl);
      } else {
        // Binding proves that no process listens, including a nonresponsive CDP endpoint.
        const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        listener.stop(true);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }));
      }
      await Bun.sleep(100);
    }
    console.log(JSON.stringify({ packaged: true, windowLoaded: true, explicitArgv: explicit, samples: 20 }));
  } finally { inspector?.close(); await stopElectronChild(child); }
}
