// test-category: race
/**
 * Quit always exits within the quit budget, in the real App:
 * - a tab in alert() and a hung tab never block quit, and their visits are saved
 *   with page titles (repeated app.quit() and repeated SIGTERM);
 * - an App-owned Agent that ignores the graceful stop is terminated, then the App exits.
 * Host: build the UI and the native Agent; set BUTLER_SMOKE_ELECTRON_EXECUTABLE,
 * BUTLER_BROWSER_EVIDENCE and BUTLER_NATIVE_AGENT_EXECUTABLE. The Agent scenario
 * pauses the Agent with SIGSTOP, so it runs on POSIX hosts only.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { shellReady } from "../support/browser-shell-acceptance";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { electronMain } from "../support/electron-main-cdp";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";
import { killOwnedProcessGroup } from "../../packages/butler-app/client/electron/butler-platform/process-group.mjs";
import { quitFixture } from "./app-quit-fixture";

// The product quit budget (QUIT_BUDGET_MS in electron/quit-feedback.mjs, which loads Electron).
const QUIT_BUDGET_MS = 15_000;
const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const electronRoot = resolve(process.env.BUTLER_SMOKE_ELECTRON_APP ?? "packages/butler-app/client/electron");
const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(electronRoot, "package.json"))})('electron')`;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const name = new URL(request.url).pathname.slice(1).split("-")[0] || "Root";
  return new Response(`<!doctype html><title>Quit ${name}</title><h1>Quit fixture</h1>`, { headers: { "content-type": "text/html" } });
} });
// Two sites, so the hung tab and the dialog tab never share a renderer.
const pageA = `http://127.0.0.1:${fixture.port}/A`, pageB = `http://localhost:${fixture.port}/B`;
type Rows = { items: Array<{ url: string; title: string; transition: string }> };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
async function waitGone(pid: number, started: number) {
  while (alive(pid)) {
    assert(performance.now() - started < QUIT_BUDGET_MS, `pid ${pid} still running after ${QUIT_BUDGET_MS} ms`);
    await new Promise(done => setTimeout(done, 20));
  }
  return Math.round(performance.now() - started);
}

async function blockedTabsQuit(how: "app.quit" | "SIGTERM") {
  const app = await browserAgentApp(join(evidence, how), () => null);
  try {
    const rows = () => app.gateway.api<Rows>("/browser-history");
    const tab = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
    await app.page.reload(); await shellReady(app, "en"); await app.call("open"); await app.click("Browser");
    const a = await app.call<string>("create", { url: pageA });
    await waitBrowser(() => app.main(`${tab(a)}?.title==="Quit A"`), "tab A loaded");
    const b = await app.call<string>("create", { url: pageB });
    await waitBrowser(() => app.main(`${tab(b)}?.title==="Quit B"`), "tab B loaded");
    await waitBrowser(async () => (await rows()).items.length === 2, "page loads recorded");
    // Not awaited: the page never answers once it is in the dialog or the loop.
    await app.main(`void ${tab(a)}.view.webContents.executeJavaScript("history.pushState({},'','/A-moved');alert('hold')")`);
    await waitBrowser(() => app.main(`Boolean(${tab(a)}.dialog)`), "tab A in alert()");
    await app.main(`void ${tab(b)}.view.webContents.executeJavaScript("history.pushState({},'','/B-moved');for(;;){}")`);
    await waitBrowser(async () => (await rows()).items.length === 4, "same-document visits committed");
    const moved = async () => (await rows()).items.filter(item => item.transition === "same_document");
    // Their titles wait for page metadata the blocked pages can no longer give.
    assert.deepEqual((await moved()).map(item => item.title === item.url), [true, true], "visit metadata still pending before quit");
    const pid = await app.main<number>("process.pid");
    const started = performance.now();
    if (how === "app.quit") await app.main(`${electron}.app.quit();setTimeout(()=>${electron}.app.quit(),200);true`);
    await app.detachMain();
    if (how === "SIGTERM") for (let n = 0; n < 2; n++) { process.kill(pid, "SIGTERM"); await new Promise(done => setTimeout(done, 200)); }
    const exitMs = await waitGone(pid, started);
    const titles = Object.fromEntries((await moved()).map(item => [new URL(item.url).pathname, item.title]));
    assert.deepEqual(titles, { "/A-moved": "Quit A", "/B-moved": "Quit B" }, "visits saved with their page titles");
    return { scenario: `blocked tabs, ${how} x2`, exit_ms: exitMs, visits: titles };
  } finally { await app.stop(); }
}

/** The Agent never answers the graceful stop: the App terminates the pid it spawned, then exits. */
async function ignoredAgentStopQuit() {
  const quit = await quitFixture();
  let output = "", agentPid = 0;
  const inspector = await freePort();
  const child = spawnElectron(process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE!, [`--inspect=${inspector}`, ...smokeBrowserArgs(), electronRoot], { env: quit.env,
    // Keep only the termination line; the stream also carries general logs.
    onOutput: chunk => { for (const line of String(chunk).split("\n")) if (/^agent did not stop in \d+ ms; terminating pid \d+$/u.test(line.trim())) output += `${line.trim()}\n`; } });
  try {
    await waitBrowser(async () => { try { return (await quit.api("/runtime-readiness")).btcc_executor_ready === true; } catch { return false; } }, "Agent ready");
    const appPid = child.pid!;
    const children = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout.trim().split("\n").map(line => line.trim().split(/\s+/u));
    agentPid = Number(children.find(([, ppid, comm]) => Number(ppid) === appPid && /(^|\/)butler-agent$/u.test(comm ?? ""))?.[0]);
    assert.ok(agentPid > 0, "App-owned Agent pid");
    process.kill(agentPid, "SIGSTOP");
    const started = performance.now();
    // One-shot inspector call: it disconnects, so it cannot hold the exiting App.
    await electronMain(inspector, `${electron}.app.quit();setTimeout(()=>${electron}.app.quit(),200);true`);
    const exitMs = await waitGone(appPid, started);
    const agentGoneMs = await waitGone(agentPid, started);
    assert.match(output, new RegExp(`^agent did not stop in \\d+ ms; terminating pid ${agentPid}$`, "mu"), "termination logged");
    agentPid = 0;
    return { scenario: "Agent ignores graceful stop, app.quit x2", exit_ms: exitMs, agent_gone_ms: agentGoneMs, log: output.trim().replace(/\d+$/u, "<pid>") };
  } finally {
    // The paused Agent is ours: never leave it behind on any exit path.
    if (agentPid && alive(agentPid)) { try { killOwnedProcessGroup(agentPid); } catch { /* fall through */ } try { process.kill(agentPid, "SIGKILL"); } catch { /* gone */ } }
    await stopElectronChild(child); quit.cleanup();
  }
}

try {
  // An optional argument runs one scenario: app.quit, SIGTERM or agent.
  const only = process.argv[2], wanted = (name: string) => !only || only === name;
  const results = [];
  if (wanted("app.quit")) results.push(await blockedTabsQuit("app.quit"));
  if (wanted("SIGTERM")) results.push(await blockedTabsQuit("SIGTERM"));
  if (wanted("agent") && process.platform !== "win32") results.push(await ignoredAgentStopQuit());
  for (const result of results) console.log(JSON.stringify(result));
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, budget_ms: QUIT_BUDGET_MS, results }, null, 2));
} finally { fixture.stop(true); }
