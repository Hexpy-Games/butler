// test-category: race
/**
 * Quit always exits within the quit budget, in the real App, and leaves no App or Agent behind:
 * - a tab in alert() and a hung tab never block quit, and their visits are saved
 *   with page titles (repeated app.quit() and repeated SIGTERM);
 * - an App-owned Agent that ignores the graceful stop is terminated, then the App exits
 *   (app.quit() and SIGTERM), and an Agent that dies while stopping never keeps the App open;
 *   after either forced exit a restarted App recovers the full queue:
 *   the interrupted active turn stays retryable and the queued follow-up is delivered once.
 * Host: build the UI and the native Agent; set BUTLER_SMOKE_ELECTRON_EXECUTABLE,
 * BUTLER_BROWSER_EVIDENCE and BUTLER_NATIVE_AGENT_EXECUTABLE. The Agent scenarios
 * pause the Agent with SIGSTOP, so they run on POSIX hosts only.
 */
import { strict as assert } from "node:assert";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { shellReady } from "../support/browser-shell-acceptance";
import { discoverOwnedGroups, killAdoptedProcessGroups, spawnElectron, stopElectronChild } from "../support/electron-child";
import { electronMain } from "../support/electron-main-cdp";
import { freePort } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";
import { ownedProcessGroupAlive } from "../../packages/butler-app/client/electron/butler-platform/process-group.mjs";
import { quitFixture } from "./app-quit-fixture";

// The product quit budget (QUIT_BUDGET_MS in electron/quit-feedback.mjs, which loads Electron).
const QUIT_BUDGET_MS = 15_000;
const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
// Desktop opens are recorded, never performed: no Finder or browser window on the host.
const openLog = join(evidence, "shell-open.jsonl");
process.env.BUTLER_TEST_SHELL_OPEN_LOG = openLog;
const electronRoot = resolve(process.env.BUTLER_SMOKE_ELECTRON_APP ?? "packages/butler-app/client/electron");
const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(electronRoot, "package.json"))})('electron')`;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const name = new URL(request.url).pathname.slice(1).split("-")[0] || "Root";
  return new Response(`<!doctype html><title>Quit ${name}</title><h1>Quit fixture</h1>`, { headers: { "content-type": "text/html" } });
} });
// Two sites, so the hung tab and the dialog tab never share a renderer.
const pageA = `http://127.0.0.1:${fixture.port}/A`, pageB = `http://localhost:${fixture.port}/B`;
type Rows = { items: Array<{ url: string; title: string; transition: string }> };
type How = "app.quit" | "SIGTERM";

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
/** The pid and every process in the group it leads are gone within the budget. */
async function waitGone(pid: number, started: number) {
  while (alive(pid) || ownedProcessGroupAlive(pid)) {
    assert(performance.now() - started < QUIT_BUDGET_MS, `pid ${pid} or its group still running after ${QUIT_BUDGET_MS} ms`);
    await pause(20);
  }
  return Math.round(performance.now() - started);
}
function finderWindows() {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("osascript", ["-e", 'tell application "Finder" to count windows'], { encoding: "utf8" });
  assert.equal(result.status, 0, "Finder window count unavailable");
  return Number(result.stdout.trim());
}
/** Quit the way the owner does: the App's own quit, or a signal; each delivered twice. */
async function requestQuit(how: How, pid: number, viaInspector: (expression: string) => Promise<unknown>) {
  if (how === "app.quit") await viaInspector(`${electron}.app.quit();setTimeout(()=>${electron}.app.quit(),200);true`);
  else for (let n = 0; n < 2 && alive(pid); n++) { process.kill(pid, "SIGTERM"); await pause(200); }
}

async function blockedTabsQuit(how: How) {
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
    if (how === "app.quit") await requestQuit(how, pid, app.main);
    // An attached main inspector holds a quitting App at exit until it disconnects.
    await app.detachMain();
    if (how === "SIGTERM") await requestQuit(how, pid, app.main);
    const exitMs = await waitGone(pid, started);
    const titles = Object.fromEntries((await moved()).map(item => [new URL(item.url).pathname, item.title]));
    assert.deepEqual(titles, { "/A-moved": "Quit A", "/B-moved": "Quit B" }, "visits saved with their page titles");
    return { scenario: `browser with blocked tabs, ${how} x2`, exit_ms: exitMs, visits: titles };
  } finally { await app.stop(); }
}

type QuitFixture = Awaited<ReturnType<typeof quitFixture>>;
async function launchQuitApp(quit: QuitFixture, onLine: (line: string) => void = () => {}) {
  const inspector = await freePort();
  // The profile belongs to the fixture root, so a restart reuses it and cleanup removes it.
  const child = spawnElectron(process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE!, [`--inspect=${inspector}`, ...smokeBrowserArgs(), electronRoot], {
    env: { ...quit.env, BUTLER_TEST_SHELL_OPEN_LOG: openLog }, cleanupPaths: [],
    onOutput: chunk => { for (const line of String(chunk).split("\n")) onLine(line.trim()); } });
  await waitBrowser(async () => { try { return (await quit.api("/runtime-readiness")).btcc_executor_ready === true; } catch { return false; } }, "Agent ready");
  const appPid = child.pid!;
  const rows = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout.trim().split("\n").map(line => line.trim().split(/\s+/u));
  const agentPid = Number(rows.find(([, ppid, comm]) => Number(ppid) === appPid && /(^|\/)butler-agent$/u.test(comm ?? ""))?.[0]);
  assert.ok(agentPid > 0, "App-owned Agent pid");
  // The Agent leads its own group: adopt it so every harness exit path kills it too.
  discoverOwnedGroups();
  // One-shot inspector calls: each disconnects, so none can hold the exiting App.
  return { child, appPid, agentPid, main: (expression: string) => electronMain(inspector, expression) };
}

/**
 * The Agent never answers the graceful stop ("hangs": the App terminates the pid it spawned, then
 * exits) or dies while stopping ("dies": the failed stop still ends in exit).
 */
async function failedAgentStopQuit(how: How, fate: "hangs" | "dies") {
  const quit = await quitFixture();
  let terminated = "";
  const children: ChildProcess[] = [];
  try {
    // Keep only the termination line; the stream also carries general logs.
    const first = await launchQuitApp(quit, line => { if (/^agent did not stop in \d+ ms; terminating pid \d+$/u.test(line)) terminated += `${line}\n`; });
    children.push(first.child);
    // The full queue: an active turn held mid-stream plus a queued follow-up.
    await quit.api("/messages", { chat_id: "general", text: "Start streaming", client_message_id: crypto.randomUUID() });
    await waitBrowser(async () => (await quit.api("/messages?chat_id=general")).messages?.some((message: any) => message.role === "assistant" && message.text?.startsWith("one")), "stream active");
    await quit.api("/session-queue", { chat_id: "general", text: "Reply waiting", client_message_id: crypto.randomUUID() });
    process.kill(first.agentPid, "SIGSTOP");
    const started = performance.now();
    await requestQuit(how, first.appPid, first.main);
    // Well inside the stop (after quit feedback and the bounded browser save), before its deadline.
    if (fate === "dies") { await pause(3_000); process.kill(first.agentPid, "SIGKILL"); }
    const exitMs = await waitGone(first.appPid, started);
    const agentGoneMs = await waitGone(first.agentPid, started);
    if (fate === "hangs") assert.match(terminated, new RegExp(`^agent did not stop in \\d+ ms; terminating pid ${first.agentPid}$`, "mu"), "termination logged");

    const restarted = await launchQuitApp(quit);
    children.push(restarted.child);
    await waitBrowser(async () => {
      const turns = (await quit.api("/turns?chat_id=general")).turns;
      return turns?.length === 2 && turns.some((turn: any) => turn.state === "delivered");
    }, "follow-up recovered after the forced exit");
    const queue = await quit.api("/session-queue?chat_id=general");
    assert.equal(queue.paused, false, "queue not paused");
    assert.equal(queue.queued_messages.length, 1, "interrupted input kept");
    assert.equal(queue.queued_messages[0].safe_error_code, "turn_interrupted");
    const turns = (await quit.api("/turns?chat_id=general")).turns;
    const interrupted = turns.find((turn: any) => (turn.turn_id ?? turn.id) === queue.queued_messages[0].turn_id);
    assert.equal(interrupted.retryable, true, "interrupted turn retryable");
    assert.equal(turns.filter((turn: any) => turn.state === "delivered").length, 1, "follow-up delivered once");
    const messages = (await quit.api("/messages?chat_id=general")).messages;
    assert.equal(messages.filter((message: any) => message.role === "user").length, 2);
    assert.equal(messages.filter((message: any) => message.role === "assistant" && message.text?.trim() === "waiting").length, 1);

    // The recovered App still quits gracefully.
    const again = performance.now();
    await requestQuit("app.quit", restarted.appPid, restarted.main);
    const restartedExitMs = await waitGone(restarted.appPid, again);
    await waitGone(restarted.agentPid, again);
    assert.equal(quit.lastExit().graceful, true, "restarted App exits gracefully");
    return { scenario: `Agent ${fate === "hangs" ? "ignores the graceful stop" : "dies while stopping"}, ${how} x2, then restart`, exit_ms: exitMs, agent_gone_ms: agentGoneMs,
      restarted_exit_ms: restartedExitMs, recovered: { delivered: 1, retryable_interrupted: 1 }, log: terminated.trim().replace(/\d+$/u, "<pid>") };
  } finally {
    // Only groups this harness spawned or adopted; a paused Agent is never left behind.
    killAdoptedProcessGroups();
    for (const child of children) await stopElectronChild(child);
    quit.cleanup();
  }
}

const finderBefore = finderWindows();
try {
  // An optional argument runs one scenario: app.quit, SIGTERM, agent, agent-SIGTERM or agent-dies.
  const only = process.argv[2], wanted = (name: string) => !only || only === name;
  const results = [];
  if (wanted("app.quit")) results.push(await blockedTabsQuit("app.quit"));
  if (wanted("SIGTERM")) results.push(await blockedTabsQuit("SIGTERM"));
  if (process.platform !== "win32") {
    if (wanted("agent")) results.push(await failedAgentStopQuit("app.quit", "hangs"));
    if (wanted("agent-SIGTERM")) results.push(await failedAgentStopQuit("SIGTERM", "hangs"));
    if (wanted("agent-dies")) results.push(await failedAgentStopQuit("app.quit", "dies"));
  }
  assert.ok(results.length, `unknown scenario ${only}`);
  const finderAfter = finderWindows();
  assert.equal(finderAfter, finderBefore, "no Finder window opened");
  const opens = existsSync(openLog) ? readFileSync(openLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  for (const result of results) console.log(JSON.stringify(result));
  console.log(JSON.stringify({ finder_windows: { before: finderBefore, after: finderAfter }, recorded_desktop_opens: opens }));
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, budget_ms: QUIT_BUDGET_MS, finder_windows: { before: finderBefore, after: finderAfter }, results }, null, 2));
} finally { fixture.stop(true); }
