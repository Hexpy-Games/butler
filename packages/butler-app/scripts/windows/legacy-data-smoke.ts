/** Legacy-data refusal and recovery on a disposable Windows runner. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronPage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { alive, bridge, click, ownedProcesses, waitFor } from "./installer-smoke-support.ts";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Legacy desktop smoke requires a disposable GitHub-hosted Windows runner");
}
const executable = resolve(process.argv[2]);
assert.ok(existsSync(executable), "Portable Butler executable is missing");
const root = mkdtempSync(join(tmpdir(), "butler-legacy-e2e-"));
const home = join(root, "home");
const data = join(home, ".butler");
const owned = new Set<number>();
const debugPort = await freePort();
const agentPort = await freePort();
const env = { ...windowsPowerShellEnvironment(), HOME: home, USERPROFILE: home, BUTLER_DATA: data,
  LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), BUTLER_SECRET_STORE: "file",
  BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub", BUTLER_PROVIDER_QUOTA_POLLING: "0",
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort),
  BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
};
let page: ElectronPage | null = null;
let phase = "legacy launch";
const registryBefore = protocolRegistry();
const started = Date.now();
try {
  for (const path of [home, env.LOCALAPPDATA, env.APPDATA, join(data, "app-server")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(data, "app-server/butler-client.sqlite"), "fake Butler 0.0.20 legacy database\n");
  writeFileSync(join(data, "keep.txt"), "preserve original data\n");
  const original = snapshot(data);
  const app = spawn(executable, [], { env, stdio: "ignore" });
  assert.ok(app.pid, "Desktop did not spawn");
  owned.add(app.pid);
  ownedProcesses(data, owned);
  page = await electronPage(debugPort);
  phase = "recovery copy";
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class~="legacy-data-recovery"]')));
  assert.equal(await page.expression("window.butlerApp.startupIssue"), "legacy-data");
  for (const [locale, title, body, buttons] of [
    ["ko", "이전 데이터 폴더예요", "Butler 0.0.20을 삭제한 뒤 .butler 폴더 이름을 바꾸고", ["폴더 열기", "다시 시작"]],
    ["en", "An older data folder", "Uninstall Butler 0.0.20, rename the .butler folder", ["Open folder", "Restart"]],
  ] as const) {
    await page.expression(`(() => { const select = document.getElementById('legacy-data-language'); select.value = ${JSON.stringify(locale)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitFor(async () => await page!.expression("document.querySelector('h1')?.textContent") === title, `legacy copy ${locale}`);
    const text = await page.expression<string>("document.body.innerText");
    assert.ok(text.includes(body));
    for (const button of buttons) assert.ok(text.includes(button));
    const layout: { labelAbove: boolean; overflow: boolean } = await page.expression(`(() => {
      const select = document.getElementById('legacy-data-language').getBoundingClientRect();
      const label = document.querySelector('label[for="legacy-data-language"]').getBoundingClientRect();
      return {labelAbove:label.bottom <= select.top, overflow:document.documentElement.scrollWidth > innerWidth};
    })()`);
    assert.deepEqual(layout, { labelAbove: true, overflow: false });
  }
  assert.deepEqual(snapshot(data), original, "Recovery screen wrote into legacy data");
  assert.ok(!existsSync(join(data, "app/runtime/foreground/instance.json")), "Agent started against legacy data");
  phase = "folder and restart";
  assert.deepEqual(await bridge(page, "recoverLegacyData", "open-folder"), { ok: true });
  renameSync(data, join(home, ".butler-0.0.20"));
  await click(page, "Restart");
  page.close(); page = null;
  await waitFor(() => !alive(app.pid!), "legacy App quit for restart");
  await waitFor(() => existsSync(join(data, "app/runtime/foreground/instance.json")), "fresh Agent instance");
  ownedProcesses(data, owned);
  page = await electronPage(debugPort);
  phase = "fresh Agent health";
  await waitFor(async () => (await bridge(page!, "health")).ok === true, "fresh Agent ready");
  assert.equal(await page.expression("window.butlerApp.startupIssue"), null);
  assert.deepEqual(snapshot(join(home, ".butler-0.0.20")), original, "Restart changed preserved legacy data");
  ownedProcesses(data, owned);
  phase = "recovery quit";
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitFor(() => [...owned].every(pid => !alive(pid)), "recovery App and Agent stopped");
  assert.equal(protocolRegistry(), registryBefore, "Protocol registry changed");
  console.log(JSON.stringify({ ok: true, legacyDataPreserved: true, recoveryCopy: ["ko", "en"],
    folderAction: true, restartToFreshAgent: true, protocolRegistryUnchanged: true, leftoverProcesses: 0,
    durationMs: Date.now() - started }));
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ phase, page: await page?.diagnostics(),
    owned: [...owned].map(pid => ({ pid, alive: alive(pid) })) }));
  throw error;
} finally {
  page?.close();
  ownedProcesses(data, owned);
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await waitFor(() => [...owned].every(pid => !alive(pid)), "legacy smoke process cleanup");
  rmSync(root, { recursive: true, force: true });
  assert.equal(protocolRegistry(), registryBefore, "Protocol registry changed during legacy smoke");
}

function protocolRegistry() {
  const result = spawnSync("reg.exe", ["query", "HKCU\\Software\\Classes\\butler", "/s"], { encoding: "utf8" });
  return JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr });
}

function snapshot(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(folder, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path] = createHash("sha256").update(readFileSync(join(folder, path))).digest("hex");
    }
  };
  visit("");
  return files;
}
