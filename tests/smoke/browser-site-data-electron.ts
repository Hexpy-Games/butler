// test-category: security
/** Settings › Browser › "Cookies and cache" in the real App with offline fixtures; stub only, no model calls.
 * The user signs in on a local site, a conversation tab keeps its own cookie, and a saved sign-in sits in a
 * throwaway keychain (never the user's). Clearing after the confirm (which names what goes and what stays)
 * removes every cookie and site storage of both profiles; the saved sign-in and the history remain. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { hostResolverRules, publicResolverPatch, startSignInFixtures } from "../support/signin-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const CANARY = "canary-pw-site-data-4d2";
const copy = getAppCopy("ko-KR").browser.siteData;
const fixtures = startSignInFixtures(CANARY);
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
// The Agent's home holds only a throwaway keychain (or the opt-in BUTLER_E2E_KEYCHAINS folder).
const agentHome = mkdtempSync(join(tmpdir(), "site-data-agent-home-"));
mkdirSync(join(agentHome, "Library/Preferences"), { recursive: true }); mkdirSync(join(agentHome, ".codex"));
if (process.env.BUTLER_E2E_KEYCHAINS) symlinkSync(process.env.BUTLER_E2E_KEYCHAINS, join(agentHome, "Library/Keychains"));
else {
  assert.equal(process.platform, "darwin", "the saved sign-in needs a system store: macOS, or BUTLER_E2E_KEYCHAINS");
  const keychain = join(agentHome, "Library/Keychains/butler-test.keychain-db"); mkdirSync(join(agentHome, "Library/Keychains"));
  for (const args of [["create-keychain", "-p", "butler-test"], ["default-keychain", "-d", "user", "-s"], ["unlock-keychain", "-p", "butler-test"]]) {
    assert.equal(spawnSync("/usr/bin/security", [...args, keychain], { env: { ...process.env, HOME: agentHome } }).status, 0, `test keychain ${args[0]}`);
  }
}
const app = await browserAgentApp(evidence, () => null, undefined, { env: { HOME: agentHome }, config: { secrets: { store: "system" } } });
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})`;
const tabOf = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
const page = <T>(id: string, code: string) => app.main<T>(`${tabOf(id)}.view.webContents.executeJavaScript(${JSON.stringify(code)})`);
/** Every cookie and the fixture's local storage key of a tab's profile. */
const stored = (id: string) => app.main<{ cookies: string[]; local: string | null }>(`(async()=>{const t=${tabOf(id)};
  const cookies=(await t.session.cookies.get({})).map(c=>c.name);
  const local=await t.view.webContents.executeJavaScript("localStorage.getItem('fixture')");return {cookies,local}})()`);
const admin = () => JSON.parse(readFileSync(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
async function agent(method: string, path: string, body?: unknown) {
  const response = await fetch(`${app.gateway.url}${path.slice(1)}`, { method, headers: { ...app.gateway.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const account = fixtures.url("www.fixture-shop.test", "/account");
const savedUser = async () => (await agent("GET", "/security/signins")).body.data.sites.find((row: { site: string }) => row.site === "fixture-shop.test")?.entry?.username as string | undefined;

try {
  await app.main(publicResolverPatch(module));
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  await app.call("open");
  // The user signs in in their own tab: the signed-in profile keeps the session cookie.
  const mine = await app.call<string>("create", { url: fixtures.url("login.fixture-shop.test", "/login") });
  await waitBrowser(() => page(mine, "Boolean(document.querySelector('input[type=password]'))"), "login page");
  await page(mine, `document.querySelector('[name=username]').value='owner@fixture.test';document.querySelector('[name=password]').value=${JSON.stringify(CANARY)};document.querySelector('form').submit()`);
  await waitBrowser(() => page(mine, "location.pathname==='/mfa'"), "mfa page");
  await page(mine, "document.querySelector('[name=code]').value='123456';document.querySelector('form').submit()");
  await waitBrowser(() => page(mine, "document.body.innerText.includes('Signed in as owner')"), "signed in");
  await page(mine, "localStorage.setItem('fixture','mine')");
  // A conversation tab keeps its own profile's cookie and storage.
  const opened = await app.main<{ status: string; tab: string }>(`globalThis.browserAgentSubject.execute(${JSON.stringify({ op: "tab.open", session: "general", args: { url: account } })})`);
  const theirs = opened.tab; assert.equal(opened.status, "ok", JSON.stringify(opened));
  await page(theirs, "document.cookie='visit=1; path=/';localStorage.setItem('fixture','theirs')");
  // The saved sign-in lives in the keychain store, and the visits in the Agent's history.
  const saved = await agent("POST", "/security/signins", { origin: fixtures.url("login.fixture-shop.test", "").replace(/\/$/u, ""), username: "owner@fixture.test", password: CANARY });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const visits = async () => (await app.gateway.api<{ items: unknown[] }>("/browser-history")).items.length;
  await waitBrowser(async () => await visits() > 0, "visits recorded");
  const before = { mine: await stored(mine), theirs: await stored(theirs), signins: await savedUser(), visits: await visits() };
  assert.ok(before.mine.cookies.includes("sid") && before.mine.local === "mine", JSON.stringify(before.mine));
  assert.ok(before.theirs.cookies.includes("visit") && before.theirs.local === "theirs", JSON.stringify(before.theirs));
  assert.equal(before.signins, "owner@fixture.test");

  // Settings › Browser: the confirm names what is cleared and what stays; cancelling clears nothing.
  await app.main(`${app.win}.webContents.loadURL('app://butler/?settings=browser')`);
  const button = "[data-settings-section-id=browser-site-data] button";
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector(${JSON.stringify(button)}))`), "site data entry");
  writeFileSync(join(evidence, "settings-browser.png"), await app.page.screenshot());
  await app.page.clickText(copy.clear, button);
  const dialog = "document.querySelector('[role=alertdialog]')";
  await waitBrowser(() => app.page.expression(`Boolean(${dialog})`), "confirm");
  const text = await app.page.expression<string>(`${dialog}.innerText`);
  for (const line of [copy.confirmTitle, copy.confirmMessage, ...copy.itemList.split("\n"), copy.kept]) assert.ok(text.includes(line), `confirm shows: ${line}`);
  await waitBrowser(() => app.page.expression("document.getAnimations().every(item => item.playState !== 'running')"), "confirm settled");
  writeFileSync(join(evidence, "confirm.png"), await app.page.screenshot());
  await app.page.press("Escape");
  await waitBrowser(() => app.page.expression(`!${dialog}`), "confirm closed");
  assert.deepEqual(await stored(mine), before.mine, "cancel clears nothing");
  await app.page.clickText(copy.clear, button);
  await waitBrowser(() => app.page.expression(`Boolean(${dialog})`), "confirm again");
  await app.page.clickText(copy.clear, "[role=alertdialog] button");
  await waitBrowser(() => app.page.expression(`document.body.innerText.includes(${JSON.stringify(copy.cleared)})`), "cleared toast");

  const after = { mine: await stored(mine), theirs: await stored(theirs), signins: await savedUser(), visits: await visits() };
  assert.deepEqual(after.mine, { cookies: [], local: null }, "the signed-in profile is empty");
  assert.deepEqual(after.theirs, { cookies: [], local: null }, "the conversation profile is empty");
  assert.equal(after.signins, "owner@fixture.test", "the saved sign-in stays");
  assert.ok(after.visits >= before.visits, "history stays");
  await app.main(`${tabOf(mine)}.view.webContents.loadURL(${JSON.stringify(account)})`);
  await waitBrowser(() => page(mine, "document.body.innerText.includes('Signed out')"), "the site sees no session");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, before, after }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("document.body.innerText").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally {
  await app.stop(); fixtures.stop(); rmSync(agentHome, { recursive: true, force: true });
}
