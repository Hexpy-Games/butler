// test-category: security
/** Native session event -> owner chooser, with no accounts in agent tabs.list. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app, BrowserWindow } from "electron";
import { createUserBrowser } from "../../packages/butler-app/client/electron/browser/tabs.mjs";

assert.ok(process.env.BUTLER_DATA);
app.setPath("userData", process.env.BUTLER_DATA);
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  console.log("ready");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Passkey privacy</title>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const host = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
  await host.loadURL("about:blank");
  console.log("host loaded");
  const browser = createUserBrowser(app, () => host);
  try {
    const id = browser.create({ owner: "conversation:passkeys", profile: "signed_out" }, false);
    const tab = browser.tabs.get(id);
    browser.materialize(tab);
    host.contentView.addChildView(tab.view);
    tab.view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    tab.view.webContents.setBackgroundThrottling(false);
    await tab.identityReady;
    console.log("identity ready");
    const contents = tab.view.webContents;
    await contents.loadURL(`http://127.0.0.1:${server.address().port}/`);
    console.log("fixture loaded");
    browser.control(id, "user", true);
    const answers = [];
    contents.session.emit("select-webauthn-account", {}, {
      relyingPartyId: "127.0.0.1", frame: contents.mainFrame,
      accounts: [{ name: "private@example.test", displayName: "Private passkey label", credentialId: "private-credential" }],
    }, credential => answers.push(credential ?? null));
    assert.equal(tab.dialog?.type, "webauthn");
    assert.equal(browser.snapshot().tabs.find(item => item.id === id).dialog.accounts.length, 1);
    const listed = await browser.execute({ op: "tabs.list", session: "passkeys" });
    assert.equal(listed.tabs.find(item => item.id === id).dialog.type, "webauthn");
    assert.doesNotMatch(JSON.stringify(listed), /Private passkey label|private@example|private-credential/u);
    assert.equal(listed.tabs.find(item => item.id === id).dialog.accounts, undefined);
    browser.close(id);
    assert.deepEqual(answers, [null]);
    console.log(JSON.stringify({ ok: true, ownerAccounts: 1, agentAccounts: 0, callbacks: answers.length }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await browser.dispose(); host.destroy(); server.close(); app.exit(process.exitCode ?? 0); }

}).catch(error => { console.error(error); app.exit(1); });
