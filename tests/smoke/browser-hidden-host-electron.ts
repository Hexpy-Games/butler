/** Hidden App host: with the App closed, the Agent runs the App's own Electron
 * without a window for its browser tools; opening the App then takes over
 * without a single-instance or channel conflict. Offline fixture, stub model. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer, freePort } from "../support/native-app-server";
import { browserStub } from "../support/browser-agent-stub";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { connectElectronMain } from "../support/electron-main-cdp";
import { waitBrowser } from "../support/browser-agent-app";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert.ok(executable, "explicit Electron 44 executable required");
const electronRoot = resolve("packages/butler-app/client/electron");
const stub = browserStub();
const gateway = await createNativeAppServer({ stubToolCall: stub.handler, env: {
  BUTLER_BROWSER_HEADLESS: "on", BUTLER_BROWSER_APP: executable, BUTLER_BROWSER_APP_DIR: electronRoot,
  // Chrome for Testing cannot come into it: nowhere to download from.
  BUTLER_BROWSER_DOWNLOAD_BASE: "http://127.0.0.1:9/",
} });
const dir = mkdtempSync(join(tmpdir(), "browser-hidden-host-"));
const logs: string[] = [];
let app: ReturnType<typeof spawnElectron> | undefined;
const hostProcesses = () => spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n")
  .filter(line => line.includes("--butler-browser-host=") && line.includes(gateway.butlerData));
async function internal(op: string, tab?: string, args = {}) {
  const admin = JSON.parse(readFileSync(join(gateway.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
  const response = await fetch(`${gateway.url}internal/browser/calls`, { method: "POST",
    headers: { ...gateway.authHeaders, "x-butler-admin": admin, "content-type": "application/json" }, body: JSON.stringify({ op, session: "general", tab, args }) });
  assert.equal(response.status, 200, op);
  return await response.json() as { status: string; tab?: string; reason?: string };
}
async function turn(text: string) {
  type View = { latest_turn?: { id: string; state: string } };
  const prior = await gateway.api<View>("/session-view?session_id=general");
  await gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => {
    const latest = (await gateway.api<View>("/session-view?session_id=general")).latest_turn;
    return latest?.id !== prior.latest_turn?.id && latest?.state === "delivered";
  }, "delivered turn");
}
try {
  await gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", access_mode: "full_access" }) });
  stub.set([
    () => ({ name: "write_file", arguments: { path: "hidden-site/index.html", create_parents: true,
      content: "<!doctype html><meta charset=\"utf-8\"><title>Hidden host</title><main><h1>Hidden host</h1><button>Confirm</button></main>" } }),
    () => ({ name: "output_publish", arguments: { path: "hidden-site", title: "Hidden host" } }),
  ]);
  await turn("Publish the fixture");
  const artifacts = await gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find(item => item.kind === "web"); assert.ok(output);
  const view = await gateway.api<{ url: string }>(`/outputs/${output.id}/view`);

  // The App is closed: the first tab starts its Electron without a window.
  const hidden = await internal("tab.open", undefined, { url: view.url });
  assert.equal(hidden.status, "ok", JSON.stringify(hidden));
  assert.equal(hostProcesses().length, 1, "one hidden host");
  const observed = await internal("tab.observe", hidden.tab, {});
  assert.equal(observed.status, "ok", JSON.stringify(observed));

  // The user opens the App: it gets its own single-instance lock and profile.
  const inspector = await freePort();
  const home = join(dir, "home"); mkdirSync(home); mkdirSync(join(dir, "profile"));
  app = spawnElectron(executable, [`--inspect=${inspector}`, electronRoot], {
    onOutput: bytes => logs.push(String(bytes)), env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: gateway.butlerData,
      BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_UI_URL: "", BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"),
      BUTLER_APP_SERVER_URL: gateway.url, BUTLER_APP_SERVER_PORT: String(gateway.port), BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub" },
  });
  let connected: Awaited<ReturnType<typeof connectElectronMain>> | undefined;
  await waitBrowser(async () => Boolean(connected ??= await connectElectronMain(inspector).catch(() => undefined)), "App main inspector");
  const main = connected!;
  const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(electronRoot, "package.json"))})('electron')`;
  await waitBrowser(async () => await main.evaluate<boolean>(`${electron}.app.hasSingleInstanceLock() && ${electron}.BrowserWindow.getAllWindows().length > 0`).catch(() => false), "App window and lock");
  // The idle hidden host hands the channel over at once and its whole tree ends.
  await waitBrowser(async () => hostProcesses().length === 0, "hidden host ended");
  const moved = await internal("tab.observe", hidden.tab, {});
  assert.equal(moved.reason, "not_your_tab", JSON.stringify(moved));
  // New work runs in the App's own browser; no hidden host comes back.
  const visible = await internal("tab.open", undefined, { url: view.url });
  assert.equal(visible.status, "ok", JSON.stringify(visible));
  assert.equal(hostProcesses().length, 0, "the App serves, not a new hidden host");
  const tabs = await main.evaluate<number>(`${electron}.webContents.getAllWebContents().filter(w => w.getURL() === ${JSON.stringify(view.url)}).length`);
  assert.equal(tabs, 1, "the tab lives in the App");
  main.close();
  console.log(JSON.stringify({ ok: true, hidden: hidden.tab, app: visible.tab }));
} catch (error) {
  console.error(logs.join("").slice(-4000));
  console.error(gateway.diagnostics().slice(-4000));
  throw error;
} finally {
  if (app) await stopElectronChild(app);
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
}
