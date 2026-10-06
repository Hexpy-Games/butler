/** Native startup failure, public Open log and actual Retry relaunch; stub model only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { _electron, chromium, type ElectronApplication, type Browser } from "playwright";
import { quitFixture } from "./app-quit-fixture";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);

const fixture = await quitFixture();
const directory = resolve("packages/butler-app/client/electron");
const executablePath = createRequire(join(directory, "package.json"))("electron") as string;
const output = resolve(process.env.BUTLER_STARTUP_EVIDENCE ?? ".tmp/startup-error-evidence");
mkdirSync(output, { recursive: true });
const config = join(fixture.data, "butler.config.json");
const validConfig = readFileSync(config);
writeFileSync(config, "{invalid config");
const debugPort = await freePort();
const env = { ...fixture.env, BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort) };
let application: ElectronApplication | undefined;
let successor: Browser | undefined;
let successorPid: number | undefined;
async function waitFor<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result as NonNullable<T>;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(label);
}
try {
  application = await _electron.launch({ executablePath, args: [...smokeBrowserArgs(), directory], env, timeout: 30_000 });
  const originalPid = application.process().pid;
  const splash = await application.firstWindow();
  await splash.getByRole("alert").waitFor();
  const log = splash.getByRole("button", { name: /로그 열기|Open log/u });
  const retry = splash.getByRole("button", { name: /다시 시도|Retry/u });
  await log.waitFor(); await retry.waitFor();
  await splash.screenshot({ path: join(output, "error.png") });
  await log.click();
  const diagnostics = join(fixture.data, "app/runtime/foreground");
  const file = await waitFor(() => readdirSync(diagnostics).find((file) => file.startsWith("lifecycle-diagnostics-")), "Open log did not write diagnostics");
  const report = JSON.parse(readFileSync(join(diagnostics, file), "utf8"));
  assert.equal(report.kind, "startup");
  assert.ok(report.failedStage);
  assert.ok(Array.isArray(report.timings));
  writeFileSync(config, validConfig);
  const originalExit = new Promise<void>((done) => application!.process().once("exit", () => done()));
  await retry.click();
  await originalExit;
  assert.equal(application.process().exitCode, 0);
  successorPid = await waitFor(() => {
    try {
      const record = JSON.parse(readFileSync(join(diagnostics, "instance.json"), "utf8"));
      return record.app_pid !== originalPid ? record.app_pid as number : undefined;
    } catch { return undefined; }
  }, "Retry did not launch a new native process");
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; }
  }, "Retry debugging endpoint unavailable");
  successor = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const main = await waitFor(() => successor!.contexts()[0]!.pages().find((page) => page.url().startsWith("app://")), "Retry main renderer unavailable");
  await main.locator("[data-test-class=app-boot]").waitFor({ state: "hidden" });
  assert.ok((await main.locator("#root").innerText()).length > 0);
  await main.screenshot({ path: join(output, "retried.png") });
  await main.evaluate(() => (window as any).butlerApp.quitApp({ confirmed: true }));
  await waitFor(() => { try { process.kill(successorPid!, 0); return false; } catch { return true; } }, "Retried app did not exit");
  successorPid = undefined;
  console.log("PASS: native config failure, Open log diagnostics/reveal, actual Retry relaunch and recovered main window");
} finally {
  await successor?.close().catch(() => undefined);
  if (successorPid) { try { process.kill(successorPid, "SIGKILL"); } catch { /* already exited */ } }
  if (application?.process().exitCode === null) await application.close();
  fixture.cleanup();
}
