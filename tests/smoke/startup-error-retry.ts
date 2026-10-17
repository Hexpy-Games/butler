import { discoverOwnedGroups, killAdoptedProcessGroups, spawnElectron, stopElectronChild } from "../support/electron-child";
/**
 * Startup error surface, both buttons, per Agent death: a failed start (repeated Retry), an Agent
 * crash and a user stop while startup is pending. Real relaunches; no inspector injection or live models.
 */
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { chromium, type Browser, type Page } from "playwright";
import { quitFixture } from "./app-quit-fixture";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";
import { nativeMainFacts } from "../support/native-main-facts";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);

type Death = "failed" | "crash" | "stopped";
type Fixture = Awaited<ReturnType<typeof quitFixture>>;
const directory = resolve("packages/butler-app/client/electron");
const nativeExecutable = process.env.BUTLER_NATIVE_APP_EXECUTABLE;
const executable = nativeExecutable ?? createRequire(join(directory, "package.json"))("electron") as string;
const output = resolve(process.env.BUTLER_STARTUP_EVIDENCE ?? ".tmp/startup-error-evidence");
const only = process.env.BUTLER_STARTUP_ERROR_DEATHS?.split(",") as Death[] | undefined;
mkdirSync(output, { recursive: true });

async function waitFor<T>(read: () => T | Promise<T>, label: string, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result as NonNullable<T>;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(label);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

// One installation for every death: a freshly copied Agent binary's first launch can be slow on macOS.
async function scenario(fixture: Fixture, death: Death, retries: number) {
  const config = join(fixture.data, "butler.config.json");
  const validConfig = readFileSync(config);
  const foreground = join(fixture.data, "app/runtime/foreground");
  const debugPort = await freePort();
  const mainPort = await freePort();
  const env: Record<string, string> = { ...fixture.env, BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort) };
  const profile = env.BUTLER_APP_ELECTRON_USER_DATA_DIR!;
  let original: ChildProcess | undefined;
  let browser: Browser | undefined;
  let appPid: number | undefined;
  let phase = "launch";
  // A relaunched App is not our child; its single-instance lock ("<host>-<pid>") names it.
  const lockHolder = (exclude?: number) => {
    try {
      const pid = Number(readlinkSync(join(profile, "SingletonLock")).split("-").pop());
      return Number.isSafeInteger(pid) && pid > 0 && pid !== exclude && alive(pid) ? pid : undefined;
    } catch { return undefined; }
  };
  // Relaunched Apps and each Agent lead their own process groups: adopt them as they appear, so
  // every harness exit path kills them, even one that fires before a wait below names them.
  let discovery: NodeJS.Timeout | undefined;
  const connect = async () => {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; }
    }, "Native debugging endpoint unavailable");
    return chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  };
  const pages = () => browser?.contexts()[0]?.pages() ?? [];
  const errorSurface = async (): Promise<Page> => {
    const surface = await waitFor(() => pages().find((page) => page.url().includes("lifecycle.html")), "Error surface unavailable");
    // A user stop leaves the renderer waiting on the stopped Agent: the surface fails only at its
    // screen (30 s) or data (30 s) stage deadline. Poll visibility: a waitFor stalls without frames.
    await waitFor(() => surface.getByRole("alert").isVisible(), `${death}: error surface did not fail`, 90_000);
    return surface;
  };
  const openLog = async (surface: Page, attempt: number) => {
    const before = new Set(readdirSync(foreground));
    await surface.getByRole("button", { name: /로그 열기|Open log/u }).click();
    const file = await waitFor(() => readdirSync(foreground).find((name) => name.startsWith("lifecycle-diagnostics-") && !before.has(name)), `${death}: Open log did not write diagnostics`);
    const report = await waitFor(() => readJson(join(foreground, file)), `${death}: diagnostics unreadable`);
    assert.equal(report.kind, "startup");
    assert.ok(report.failedStage, `${death}: report names the failed stage`);
    assert.ok(report.timings.some((event: { stage?: string }) => event.stage === "failed"));
    // Open log reveals the App-spawned Agent's own log, which holds the real failure.
    assert.equal(report.agentLog, "logs/butler-agent-app.log", `${death}: Open log reveals the Agent log`);
    if (death === "failed") {
      await waitFor(() => readFileSync(join(fixture.data, report.agentLog), "utf8").includes("[native-service] failed:"), "Agent log did not record the startup failure");
    }
    console.log(JSON.stringify({ death, attempt, openLog: { failedStage: report.failedStage, supervisor: report.supervisor } }));
  };
  // Kill or stop the running Agent once it is ready, while the startup surface is still pending.
  const induce = async () => {
    const progress = join(foreground, "startup-progress.json");
    // Within the App's own service-stage deadline (120 s): a fresh Agent binary's first launch can be slow.
    await waitFor(() => readJson(progress)?.timings?.some((event: { stage?: string }) => event.stage === "agent_ready"), `${death}: Agent never became ready`, 120_000);
    const pid = readJson(join(foreground, "instance.json"))?.agent_host_pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `${death}: ready Agent pid recorded`);
    if (death === "crash") process.kill(-pid, "SIGKILL");
    else {
      const stop = spawnSync(env.BUTLER_NATIVE_AGENT_EXECUTABLE!, ["--installation-root", join(fixture.root, "install"), "--resource-root", join(fixture.root, "install/resources"), "stop", "--data", fixture.data, "--quiet"], { env, encoding: "utf8" });
      assert.equal(stop.status, 0, `butler-agent stop: ${stop.stderr.trim().split("\n").pop()}`);
    }
    await waitFor(() => !alive(pid), `${death}: Agent did not exit`);
  };
  try {
    // The previous death's progress record would satisfy this one's readiness wait.
    rmSync(join(foreground, "startup-progress.json"), { force: true });
    if (death === "failed") writeFileSync(config, "{invalid config");
    original = spawnElectron(executable, [`--inspect=${mainPort}`, ...smokeBrowserArgs(), ...(nativeExecutable ? [] : [directory])], { env, relaunches: true });
    appPid = original.pid!;
    discovery = setInterval(discoverOwnedGroups, 100);
    if (death !== "failed") await induce();
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      phase = `error-${attempt}`;
      browser = await connect();
      const surface = await errorSurface();
      // The main window already exists once the Agent was ready; Retry must still quit it.
      if (death !== "failed") assert.ok(pages().some((page) => page.url().startsWith("app://")), `${death}: main window exists`);
      await surface.screenshot({ path: join(output, `${death}-error-${attempt}.png`) });
      phase = `open-log-${attempt}`;
      await openLog(surface, attempt);
      if (attempt === retries) writeFileSync(config, validConfig);
      phase = `retry-${attempt}`;
      const failed: number = appPid!;
      await surface.getByRole("button", { name: /다시 시도|Try again/u }).click();
      // Release the attached renderer debugger before observing native process exit.
      await browser.close(); browser = undefined;
      await waitFor(() => !alive(failed), `${death}: Retry ${attempt} did not exit the failed App`);
      if (failed === original.pid) assert.equal(original.exitCode, 0);
      appPid = await waitFor(() => lockHolder(failed), `${death}: Retry ${attempt} did not start a successor App`);
      const facts = await waitFor(async () => {
        try { const value = await nativeMainFacts(mainPort, fixture.data); return value.pid === appPid ? value : undefined; }
        catch { return undefined; }
      }, `${death}: retried main inspector unavailable`);
      assert.equal(facts.dataIsolated, true, "Retry preserves its isolated data root");
      assert.equal(facts.shellIsolated, true, "Retry preserves disabled shell registration");
    }
    phase = "recovered";
    browser = await connect();
    await waitFor(() => readJson(join(foreground, "instance.json"))?.app_pid === appPid, `${death}: retried App did not launch the Agent`);
    const main = await waitFor(() => pages().find((page) => page.url().startsWith("app://")), `${death}: retried main renderer unavailable`);
    await main.locator("[data-test-class=app-boot]").waitFor({ state: "hidden" });
    await waitFor(async () => (await main.locator("#root").innerText()).length > 0, `${death}: retried renderer content unavailable`);
    await main.screenshot({ path: join(output, `${death}-retried.png`) });
    await main.evaluate(() => (window as any).butlerApp.quitApp({ confirmed: true }));
    const quitting: number = appPid!;
    await waitFor(() => !alive(quitting), `${death}: retried App did not exit`);
    appPid = undefined;
    console.log(JSON.stringify({ death, pass: { retries } }));
  } catch (error) {
    const surface = pages().find((page) => page.url().includes("lifecycle.html"));
    const state = await surface?.evaluate(() => (window as any).butlerLifecycle.state()).catch(() => undefined);
    const record = readJson(join(foreground, "startup-progress.json"));
    console.error(JSON.stringify({ death, phase, message: error instanceof Error ? error.message.split("\n")[0] : "unknown",
      surface: state && { stage: state.stage, state: state.state, failedStage: state.failedStage },
      progress: record && { stage: record.stage, timings: record.timings?.map((event: { stage: string }) => event.stage).slice(-12) } }));
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    clearInterval(discovery);
    discoverOwnedGroups();
    const successor = lockHolder(original?.pid);
    if (successor) {
      // Quit a relaunched App through its own Quit so its Agent stops; its adopted group is then killed.
      const quit = spawnElectron(executable, [...smokeBrowserArgs(), ...(nativeExecutable ? [] : [directory]), "--butler-quit-main-ui"], { env, cleanupPaths: [] });
      try { await Promise.race([once(quit, "exit"), new Promise((done) => setTimeout(done, 10_000))]); await waitFor(() => !alive(successor), "Retry cleanup did not exit the successor", 10_000); }
      catch { /* killed below */ } finally { await stopElectronChild(quit); }
    }
    killAdoptedProcessGroups();
    if (original) await stopElectronChild(original);
    writeFileSync(config, validConfig);
  }
}

const deaths: Array<[Death, number]> = [["failed", 2], ["crash", 1], ["stopped", 1]];
const fixture = await quitFixture();
let cleaned = false;
const cleanup = () => { if (!cleaned) { cleaned = true; fixture.cleanup(); } };
// Every exit path, after the harness's own exit hook (registered first) has killed the Apps.
process.once("exit", cleanup);
for (const [death, retries] of deaths) if (!only || only.includes(death)) await scenario(fixture, death, retries);
cleanup();
console.log("PASS: startup error Open log and Retry after a failed start (repeated Retry), an Agent crash and a user stop");
