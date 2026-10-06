/** Native failure, Open log and real Retry relaunch; no inspector injection or live models. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium, type Browser } from "playwright";
import { quitFixture } from "./app-quit-fixture";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";
import { nativeMainFacts } from "../support/native-main-facts";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);

const fixture = await quitFixture();
const directory = resolve("packages/butler-app/client/electron");
const nativeExecutable = process.env.BUTLER_NATIVE_APP_EXECUTABLE;
const executable = nativeExecutable ?? createRequire(join(directory, "package.json"))("electron") as string;
const output = resolve(process.env.BUTLER_STARTUP_EVIDENCE ?? ".tmp/startup-error-evidence");
mkdirSync(output, { recursive: true });
const config = join(fixture.data, "butler.config.json");
const validConfig = readFileSync(config);
writeFileSync(config, "{invalid config");
const debugPort = await freePort();
const mainPort = await freePort();
const env = { ...fixture.env, BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort) };
let original: ChildProcess | undefined;
let browser: Browser | undefined;
let successorPid: number | undefined;
let phase = "launch";
async function waitFor<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result as NonNullable<T>;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(label);
}
async function connect() {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; }
  }, "Native debugging endpoint unavailable");
  return chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
}
try {
  original = spawn(executable, [`--inspect=${mainPort}`, ...smokeBrowserArgs(), ...(nativeExecutable ? [] : [directory])], { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [original.stdout, original.stderr]) {
    let pending = "";
    stream?.on("data", (chunk) => {
      const lines = (pending + String(chunk)).split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) { try { const event = JSON.parse(line).startup; if (event?.stage?.startsWith("retry_")) console.log(JSON.stringify({ startup: event })); } catch { /* selected timings only */ } }
    });
  }
  browser = await connect();
  const splash = await waitFor(() => browser!.contexts()[0]!.pages().find((page) => page.url().includes("lifecycle.html")), "Error surface unavailable");
  await splash.getByRole("alert").waitFor();
  const log = splash.getByRole("button", { name: /로그 열기|Open log/u });
  const retry = splash.getByRole("button", { name: /다시 시도|Try again/u });
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
  console.log(JSON.stringify({ failureSupervisor: report.supervisor }));
  console.log(JSON.stringify({ originalFacts: await nativeMainFacts(mainPort, fixture.data) }));
  await splash.bringToFront();
  phase = "retry-click";
  await retry.click();
  await waitFor(() => original!.exitCode !== null || original!.signalCode !== null, "Retry did not exit the failed process");
  assert.equal(original.exitCode, 0);
  phase = "original-exit";
  await browser.close(); browser = undefined;
  browser = await connect();
  phase = "successor-inspector";
  const facts = await waitFor(async () => {
    try { const value = await nativeMainFacts(mainPort, fixture.data); return value.pid !== original!.pid ? value : undefined; }
    catch { return undefined; }
  }, "Retried main inspector unavailable");
  successorPid = facts.pid;
  console.log(JSON.stringify({ retryProcess: facts }));
  assert.equal(facts.dataIsolated, true, "Retry preserves its isolated data root");
  assert.equal(facts.shellIsolated, true, "Retry preserves disabled shell registration");
  try {
    await waitFor(() => {
      try { return JSON.parse(readFileSync(join(diagnostics, "instance.json"), "utf8")).app_pid === successorPid; }
      catch { return false; }
    }, "Retried process did not enter foreground Agent launch");
  } catch (error) {
    const retrySurface = browser.contexts()[0]!.pages().find((page) => page.url().includes("lifecycle.html"));
    const state = await retrySurface?.evaluate(() => (window as any).butlerLifecycle.state());
    console.log(JSON.stringify({ retryFailure: { pid: successorPid, kind: state?.kind, stage: state?.stage, state: state?.state, failedStage: state?.failedStage, pages: browser.contexts()[0]!.pages().map((page) => new URL(page.url()).protocol) } }));
    throw error;
  }
  const main = await waitFor(() => browser!.contexts()[0]!.pages().find((page) => page.url().startsWith("app://")), "Retry main renderer unavailable");
  await main.locator("[data-test-class=app-boot]").waitFor({ state: "hidden" });
  assert.ok((await main.locator("#root").innerText()).length > 0);
  await main.screenshot({ path: join(output, "retried.png") });
  await main.evaluate(() => (window as any).butlerApp.quitApp({ confirmed: true }));
  await waitFor(() => { try { process.kill(successorPid!, 0); return false; } catch { return true; } }, "Retried app did not exit");
  successorPid = undefined;
  console.log("PASS: native config failure, Open log diagnostics/reveal, actual Retry relaunch and recovered main window");
} catch (error) {
  console.error(JSON.stringify({ retryFailure: { phase, message: error instanceof Error ? error.message.split("\n")[0] : "unknown" } }));
  throw error;
} finally {
  if (successorPid) { try { process.kill(successorPid, "SIGKILL"); } catch { /* already exited */ } }
  if (original?.exitCode === null && original.signalCode === null) {
    const exited = once(original, "exit");
    original.kill("SIGTERM");
    const kill = setTimeout(() => original?.kill("SIGKILL"), 10_000);
    try { await exited; } finally { clearTimeout(kill); }
  }
  await browser?.close().catch(() => undefined);
  fixture.cleanup();
}
