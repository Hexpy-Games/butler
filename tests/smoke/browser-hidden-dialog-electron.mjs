// Page dialogs in a hidden agent tab stay in the in-app dialog flow and never show an OS window.
// test-category: race
// Run: HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d) <electron 44> tests/smoke/browser-hidden-dialog-electron.mjs
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const browserDir = new URL(process.env.BUTLER_SMOKE_BROWSER_DIR ?? "../../packages/butler-app/client/electron/browser/", import.meta.url);
const { createUserBrowser } = await import(new URL("tabs.mjs", browserDir).href);
const { backgroundTab, connectDebugger } = await import(new URL("agent.mjs", browserDir).href);
const { answerDialog, requestClose } = await import(new URL("dialogs.mjs", browserDir).href);
assert.ok(process.env.BUTLER_DATA, "BUTLER_DATA required");
app.setPath("userData", process.env.BUTLER_DATA);
app.setPath("crashDumps", `${process.env.BUTLER_DATA}/crash`); app.setPath("logs", `${process.env.BUTLER_DATA}/logs`);
app.on("window-all-closed", () => {});

const page = `<!doctype html><title>dialogs</title><body><script>
window.ask = kind => setTimeout(() => { window.answer = kind === "confirm" ? confirm("confirm?") : alert("alert!"); window.done = kind; }, 0);
window.guard = () => { window.onbeforeunload = event => { event.preventDefault(); return "leave?"; }; };
</script></body>`;
const wait = async (read, label, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 25)); }
  throw new Error(`Timed out: ${label}`);
};

async function checkOcclusion(browser, tab, main) {
  const bounds = { x: 10, y: 20, width: 320, height: 200, scale: 0.25, visible: true };
  browser.areaVisible = true;
  browser.activate(tab.id);
  browser.commandTab("covered", tab.id, true);
  browser.commandTab("bounds", tab.id, bounds);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    browser.commandTab("covered", tab.id, false);
    assert.equal(tab.attached, main, "uncovered page returns to its card without another layout event");
    assert.deepEqual(tab.view.getBounds(), { x: 10, y: 20, width: 320, height: 200 });
    assert.equal(tab.bounds.scale, 0.25);
    assert.deepEqual(await tab.view.webContents.executeJavaScript("[innerWidth, innerHeight]"), [1280, 800]);
    browser.commandTab("covered", tab.id, true);
    assert.equal(tab.attached, browser.agentWindow);
    assert.equal(tab.bounds.scale, 1, "hidden operations use logical viewport coordinates");
    assert.deepEqual(tab.view.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  }
  browser.hide();
  browser.commandTab("covered", tab.id, false);
  assert.equal(tab.attached, browser.agentWindow, "hidden browser stays in the background");
}

app.whenReady().then(async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const main = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { sandbox: true } });
  await main.loadURL("about:blank");
  main.showInactive();
  const browser = createUserBrowser(app, () => main);
  const visible = () => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed() && win.isVisible()).map(win => win.id);
  const before = visible();
  // As openTab does: a background conversation tab in the hidden agent window.
  // A loopback fixture is reachable only as previewed content.
  const id = browser.create({ owner: "conversation:s1", url, agent: true, policy: { content_origin: new URL(url).origin, preview: true } }, false);
  const tab = browser.tabs.get(id);
  browser.materialize(tab); backgroundTab(browser, tab);
  await new Promise(resolve => setTimeout(resolve, 0));
  connectDebugger(browser, tab);
  await tab.identityReady; await tab.view.webContents.loadURL(url);
  const contents = tab.view.webContents;
  await checkOcclusion(browser, tab, main);
  assert.ok(browser.agentWindow && !browser.agentWindow.isVisible(), "agent window starts hidden");
  const events = () => browser.events?.get("conversation:s1") ?? [];
  const results = {};

  for (const kind of ["alert", "confirm"]) {
    const seen = events().length;
    await contents.executeJavaScript(`window.ask(${JSON.stringify(kind)})`);
    const dialog = await wait(() => tab.dialog, `${kind} reaches the dialog flow`);
    await new Promise(resolve => setTimeout(resolve, 700)); // a native sheet would have shown its window by now
    assert.equal(dialog.type, kind);
    assert.ok(events().slice(seen).some(event => event.type === "dialog_opened" && event.dialog.type === kind), `${kind}: dialog_opened event for the agent`);
    assert.equal(browser.agentWindow.isVisible(), false, `${kind}: hidden agent window stays hidden`);
    assert.deepEqual(visible(), before, `${kind}: no new visible window`);
    const answered = await answerDialog(browser, tab, { dialog: dialog.id, accept: true });
    assert.equal(answered.status, "ok", `${kind}: agent answer accepted`);
    await wait(() => contents.executeJavaScript(`window.done === ${JSON.stringify(kind)}`), `${kind} page resumes`);
    results[kind] = await contents.executeJavaScript("window.answer ?? null");
    assert.equal(tab.dialog, null);
  }
  assert.equal(results.confirm, true, "confirm receives the agent's answer");

  // beforeunload on agent close keeps its in-app flow; no window either.
  await contents.executeJavaScript("window.guard()", true);
  const closing = await requestClose(browser, tab);
  assert.ok(["dialog_pending", "ok"].includes(closing.status), `close status ${closing.status}`);
  if (closing.status === "dialog_pending") {
    assert.equal(closing.dialog.type, "beforeunload");
    assert.equal(browser.agentWindow.isVisible(), false, "beforeunload: hidden agent window stays hidden");
    assert.deepEqual(visible(), before, "beforeunload: no new visible window");
    await answerDialog(browser, tab, { dialog: closing.dialog.id, accept: true });
  }
  await wait(() => !browser.tabs.has(id), "agent tab closes");
  assert.deepEqual(visible(), before, "no new visible window after close");
  console.log(JSON.stringify({ ok: true, results, beforeunload: closing.status, visibleWindows: visible().length }));
  server.close(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
