/** Real Electron: failure/signal cleanup and quitting after the gateway disappears. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { freePort } from "../support/native-app-server";
import { withApp } from "../support/electron-child";
import { connectElectronMain } from "../support/electron-main-cdp";
import { electronPage } from "../support/electron-page-cdp";
import { smokeElectronArgs } from "../support/smoke-browser";
import { smokeAppGateway } from "../support/smoke-app-gateway";
import { ownedProcessGroupAlive } from "../../packages/butler-app/client/electron/butler-platform/process-group.mjs";

const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);
const evidence = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert.ok(evidence, "Persistent evidence directory required");
mkdirSync(evidence, { recursive: true });
const mode = process.env.BUTLER_SMOKE_TEARDOWN_CASE;
if (mode) await runApp(mode);
else await runCases();

async function waitFor(read: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (!await read()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(done => setTimeout(done, 20));
  }
}

async function runApp(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "butler-app-teardown-"));
  const home = join(dir, "home"), profile = join(dir, "profile"); mkdirSync(home);
  const gateway = await smokeAppGateway();
  const debug = await freePort(), inspector = await freePort();
  const entry = resolve("packages/butler-app/client/electron");
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ?? createRequire(join(entry, "package.json"))("electron") as string;
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(entry, "package.json"))})('electron')`;
  try {
    await withApp(executable, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), entry], {
      onOutput: bytes => {
        for (const line of String(bytes).split("\n")) {
          if (/Waiting for the debugger|desktop-quit|foreground_stop|foreground_shutdown/u.test(line)) {
            appendFileSync(join(evidence!, `${mode}-quit-log.txt`), line + "\n");
          }
        }
      },
      cleanupPaths: [dir], env: { ...process.env, HOME: home, BUTLER_DATA: join(dir, "data"),
        BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_SERVER_URL: gateway.url,
        BUTLER_APP_SERVER_PORT: String(gateway.port), BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub" },
    }, async child => {
      const page = await electronPage(debug);
      const main = await connectElectronMain(inspector);
      try {
        await page.waitForFunction(() => Boolean(window.butlerApp) && document.readyState === "complete" && Boolean(document.querySelector("[data-first-run-screen]")) && !document.querySelector('[data-test-class="app-boot"]'));
        const pids = await main.evaluate<number[]>(`${module}.app.getAppMetrics().map(item=>item.pid)`);
        assert.ok(pids.length > 1, "Real Electron helpers present");
        writeFileSync(join(evidence!, `${mode}-owned.json`), JSON.stringify({ pid: child.pid, pids, profile, dir }));
        if (mode === "service-down") writeFileSync(join(evidence!, "service-down-before-quit.png"), await page.screenshot());
        await gateway.stop();
        if (mode === "service-down") {
          // Exit evidence survives disconnection; no new quit card or dialog is allowed.
          await main.evaluate(`(()=>{
            const {app,dialog}=${module};let windows=0,dialogs=0;
            app.on('browser-window-created',()=>windows++);
            for(const key of ['showMessageBox','showMessageBoxSync','showErrorBox'])dialog[key]=()=>{dialogs++;throw Error('Unexpected quit dialog')};
            app.once('quit',()=>process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(evidence!, "service-down-quit.json"))},JSON.stringify({windows,dialogs})));
            setImmediate(()=>app.quit());return true;
          })()`);
          main.close(); page.close();
          await waitFor(() => child.exitCode !== null || child.signalCode !== null, "App exits with gateway down");
          assert.equal(child.exitCode, 0);
          assert.deepEqual(JSON.parse(readFileSync(join(evidence!, "service-down-quit.json"), "utf8")), { windows: 0, dialogs: 0 });
        } else if (mode === "assertion") assert.fail("Forced smoke assertion failure");
        else if (mode === "throw") throw new Error("Forced smoke error");
        else if (mode === "timeout") await new Promise((_, reject) => setTimeout(() => reject(new Error("Forced smoke timeout")), 20));
        else if (mode === "SIGINT" || mode === "SIGTERM") process.kill(process.pid, mode);
        else if (mode === "exit") process.exit(7);
        else if (mode.startsWith("runner-")) await new Promise(() => {});
        else assert.equal(mode, "success");
      } finally { page.close(); main.close(); }
    });
  } finally { await gateway.stop(); rmSync(dir, { recursive: true, force: true }); }
}

async function runCases() {
  const results = [];
  const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  const cases = ["assertion", "throw", "timeout", "SIGINT", "SIGTERM", "exit", "success", "service-down", "runner-SIGINT", "runner-SIGTERM"];
  assert.ok(!selected || cases.includes(selected));
  for (const mode of selected ? [selected] : cases) {
    const isolation = mkdtempSync(join(tmpdir(), "butler-teardown-runner-"));
    const home = join(isolation, "home"); mkdirSync(home);
    const record = join(evidence!, `${mode}-owned.json`); rmSync(record, { force: true });
    const log = openSync(join(evidence!, `${mode}-runner.log`), "w");
    const wrapped = mode.startsWith("runner-");
    const child = spawn(wrapped ? "bun" : process.execPath, [wrapped ? resolve("tests/smoke/app-teardown-smoke.ts") : process.argv[1]!], { stdio: ["ignore", log, log], env: {
      ...process.env, HOME: home, BUTLER_DATA: join(isolation, "data"), BUTLER_SMOKE_TEARDOWN_CASE: mode,
    } }); closeSync(log);
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    try {
      const exited = new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("exit", done); });
      if (wrapped) { await waitFor(() => existsSync(record), "Wrapped runner launched real App"); child.kill(mode.slice(7) as NodeJS.Signals); }
      const code = await exited;
      assert.ok(existsSync(record), `${mode}: reached real App check (see runner log)`);
      const owned = JSON.parse(readFileSync(record, "utf8")) as { pid: number; pids: number[]; profile: string; dir: string };
      await waitFor(() => !ownedProcessGroupAlive(owned.pid), `${mode}: Electron process group gone`);
      for (const pid of owned.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${mode}: helper ${pid} gone`);
      assert.equal(existsSync(owned.profile), false); assert.equal(existsSync(owned.dir), false);
      const forced = ({ assertion: "Forced smoke assertion failure", throw: "Forced smoke error", timeout: "Forced smoke timeout" } as Record<string, string>)[mode];
      if (forced) assert.ok(readFileSync(join(evidence!, `${mode}-runner.log`), "utf8").includes(forced), "Failure came from the intended check");
      assert.equal(code, mode.endsWith("SIGINT") ? 130 : mode.endsWith("SIGTERM") ? 143 : mode === "exit" ? 7 : ["success", "service-down"].includes(mode) ? 0 : 1);
      const result = { mode, code, processesRemaining: 0, profileRemoved: true };
      results.push(result);
      writeFileSync(join(evidence!, `${mode}-result.json`), JSON.stringify(result, null, 2));
      writeFileSync(join(evidence!, "teardown-result.json"), JSON.stringify(results, null, 2));
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      rmSync(isolation, { recursive: true, force: true });
    }
  }
  writeFileSync(join(evidence!, "teardown-result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
