// test-category: security
/** Saving a sign-in from the user's own tab; offline fixtures and a throwaway keychain. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { hostResolverRules, publicResolverPatch, startSignInFixtures } from "../support/signin-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const CANARY = "canary-pw-save-signin-4d2";
const copy = getAppCopy("ko-KR").browser;
const fixtures = startSignInFixtures(CANARY);
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
// The Agent's home holds only a throwaway keychain (or the opt-in BUTLER_E2E_KEYCHAINS folder).
const agentHome = mkdtempSync(join(tmpdir(), "save-signin-agent-home-"));
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
const admin = () => JSON.parse(readFileSync(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
async function agent(method: string, path: string, body?: unknown) {
  const response = await fetch(`${app.gateway.url}${path.slice(1)}`, { method, headers: { ...app.gateway.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
try {
  await app.main(publicResolverPatch(module));
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  await app.call("open");
  const handoff = await app.call<string>("create", { owner: "conversation:general", url: fixtures.url("login.fixture-shop.test", "/login") });
  await app.page.clickSelector('[data-slot="titlebar-leading"] button');
  await waitBrowser(() => app.main(`Boolean(${tabOf(handoff)}.attached && !${tabOf(handoff)}.covered)`), "hand-off page attached");
  await waitBrowser(() => page(handoff, "Boolean(document.querySelector('input[type=password]'))"), "hand-off login page");
  const postsBefore = fixtures.posts.length;
  const filled = await app.main<{ status: string }>(`(async()=>{
    const browser=globalThis.browserAgentSubject,tab=${tabOf(handoff)},previous=browser.pullInput;
    await browser.execute({op:"tab.wait", session:"general", tab:tab.id});
    browser.pullInput=async()=>({username:"owner@fixture.test",password:${JSON.stringify(CANARY)}});
    try {return await browser.execute({op:"input.fill",session:"general",tab:tab.id,args:{token:"fixture"}});}
    finally {browser.pullInput=previous;}
  })()`);
  assert.equal(filled.status, "filled");
  assert.ok(fixtures.posts.slice(postsBefore).includes("login.fixture-shop.test/session"));
  // The fixture redirects only when both posted values match.
  await waitBrowser(() => page(handoff, "location.pathname==='/mfa'"), "hand-off sign-in accepted");
  await waitBrowser(() => app.main(`${tabOf(handoff)}.saveOffer?.username === "owner@fixture.test"`), "hand-off save offer");
  await app.call("close", { id: handoff });
  const mine = await app.call<string>("create", { url: fixtures.url("login.fixture-shop.test", "/login") });
  await app.click("브라우저");
  await waitBrowser(() => page(mine, "Boolean(document.querySelector('input[type=password]'))"), "login page");
  // A user's click gives the page native focus; without it, synthetic keys can be dropped.
  await app.main(`${tabOf(mine)}.view.webContents.focus()`);
  await page(mine, "document.querySelector('[name=username]').focus()");
  await app.main(`${tabOf(mine)}.view.webContents.insertText("owner@fixture.test")`);
  await page(mine, "document.querySelector('[name=password]').focus()");
  await app.main(`${tabOf(mine)}.view.webContents.insertText(${JSON.stringify(CANARY)})`);
  await app.main(`(()=>{const view=${tabOf(mine)}.view;for(const type of ['keyDown','char','keyUp'])view.webContents.sendInputEvent({type,keyCode:'Enter'})})()`);
  const band = "document.querySelector('[data-test-class=browser-save-signin]')";
  await waitBrowser(() => app.page.expression(`Boolean(${band})`), "save sign-in band");
  const text = await app.page.expression<string>(`${band}.innerText`);
  assert.ok(text.includes("owner@fixture.test"));
  assert.ok(text.includes(copy.saveSignIn));
  assert.ok(!text.includes(copy.giveBack));
  assert.ok(!JSON.stringify(await app.main("globalThis.browserAgentSubject.snapshot()")).includes(CANARY), "snapshot excludes the password");
  await app.shot("band");
  await app.page.clickText(copy.saveSignIn, "[data-test-class=browser-save-signin] button");
  await waitBrowser(() => app.page.expression(`!${band}`), "sign-in saved");
  await waitBrowser(async () => (await agent("GET", "/security/signins")).body.data.sites.some((row: { site: string; entry?: { username: string } }) => row.site === "fixture-shop.test" && row.entry?.username === "owner@fixture.test"), "saved entry");
  const origin = fixtures.url("login.fixture-shop.test", "").replace(/\/$/u, "");
  const same = await agent("POST", "/security/signins/offer", { origin, username: "owner@fixture.test", password: CANARY });
  assert.equal(same.body.data.offer, false, "the saved sign-in is not offered again");
  const changed = await agent("POST", "/security/signins/offer", { origin, username: "owner@fixture.test", password: CANARY + "x" });
  assert.equal(changed.body.data.offer, true, "a changed password is offered");
  const second = await agent("POST", "/security/signins", { origin, username: "second@fixture.test", password: "second-pw" });
  assert.equal(second.status, 200);
  await app.call("navigate", { id: mine, value: fixtures.url("login.fixture-shop.test", "/login") });
  await waitBrowser(() => page(mine, "Boolean(document.querySelector('[name=username]'))"), "login page again");
  const point = await page<{ x: number; y: number }>(mine, "(()=>{const r=document.querySelector('[name=username]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  await app.main(`(()=>{const contents=${tabOf(mine)}.view.webContents;for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,x:${point.x},y:${point.y}});})()`);
  const suggest = "globalThis.browserAgentSubject.signinSuggest.view";
  await waitBrowser(() => app.main(`Boolean(${suggest} && ${suggest}.webContents.getURL().endsWith('#signin'))`), "sign-in suggestions shown");
  await waitBrowser(async () => await app.main(`${suggest}.webContents.executeJavaScript("document.querySelectorAll('[role=option]').length")`) === 2, "two sign-in suggestions");
  const input = await page<{ x: number; y: number; height: number }>(mine, "(()=>{const {x,y,height}=document.querySelector('[name=username]').getBoundingClientRect();return {x,y,height}})()");
  await waitBrowser(async () => {
    const at = await app.main<{ x: number; y: number; page: { x: number; y: number }; zoom: number; height: number; list: { x: number; y: number; bottom: number; surface: number } }>(`(async()=>({...${suggest}.getBounds(),page:${tabOf(mine)}.view.getBounds(),zoom:${tabOf(mine)}.view.webContents.getZoomFactor(),
      list:await ${suggest}.webContents.executeJavaScript("(()=>{const {x,y,bottom}=document.querySelector('[data-slot=suggestion-list]').getBoundingClientRect();return {x,y,bottom,surface:document.querySelector('[data-popover-density=list]').getBoundingClientRect().bottom}})()")}))()`);
    return at.y + at.list.y >= at.page.y + (input.y + input.height) * at.zoom && Math.abs(at.x + at.list.x - at.page.x - input.x * at.zoom) <= 8 && at.list.bottom <= at.list.surface && at.list.surface <= at.height;
  }, "whole suggestion list under the input, at its left edge");
  // app.shot focuses the App window, which correctly closes the list; capture the window as it is.
  const source = await app.main<string>(`${app.win}.getMediaSourceId()`);
  assert.equal(Bun.spawnSync([process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE!, source.split(":")[1]!, join(evidence, "fill-suggest.png")]).exitCode, 0);
  await app.main(`(()=>{const contents=${tabOf(mine)}.view.webContents;for(const type of ['keyDown','keyUp'])contents.sendInputEvent({type,keyCode:'Down'});})()`);
  await waitBrowser(async () => await app.main(`${suggest}.webContents.executeJavaScript("document.querySelector('[role=option]').getAttribute('aria-selected')")`) === "true", "arrow key highlights the first sign-in");
  // A real click moves native focus to the list before the click lands.
  const row = await app.main<{ x: number; y: number }>(`${suggest}.webContents.executeJavaScript("(()=>{const r=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('owner@fixture.test')).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")`);
  await app.main(`(()=>{const contents=${suggest}.webContents;contents.focus();for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,x:${row.x},y:${row.y}});})()`);
  await waitBrowser(() => page(mine, `document.querySelector('[name=username]').value==='owner@fixture.test' && document.querySelector('[name=password]').value.length===${CANARY.length}`), "sign-in filled");
  await app.main(`(()=>{const view=${tabOf(mine)}.view;for(const type of ['keyDown','char','keyUp'])view.webContents.sendInputEvent({type,keyCode:'Enter'})})()`);
  await waitBrowser(() => page(mine, "location.pathname==='/mfa'"), "filled sign-in accepted");

  const username = "owner@fixture.test";
  const enter = "for(const type of ['keyDown','char','keyUp'])contents.sendInputEvent({type,keyCode:'Enter'})";
  async function signIn(tab: string, fieldSteps: [string, string][], framed = false) {
    const contents = `${tabOf(tab)}.view.webContents`;
    await app.main(`${contents}.focus()`);
    for (const [field, value] of fieldSteps) {
      await app.main(`${contents}${framed ? ".mainFrame.frames[0]" : ""}.executeJavaScript(${JSON.stringify(`document.querySelector('[name=${field}]').focus()`)})`);
      await app.main(`${contents}.insertText(${JSON.stringify(value)})`);
    }
    await app.main(`(()=>{const contents=${contents};${enter}})()`);
  }
  async function saveBand() {
    await waitBrowser(() => app.page.expression(`Boolean(${band})`), "save sign-in band");
    assert.ok(await app.page.expression(`${band}.innerText.includes(${JSON.stringify(username)})`));
    await app.page.clickText(copy.saveSignIn, "[data-test-class=browser-save-signin] button");
    await waitBrowser(() => app.page.expression(`!${band}`), "sign-in saved");
  }
  const cases = [
    { site: "fixture-id.test", url: fixtures.url("accounts.fixture-id.test", "/id"), twoStep: true },
    { site: "fixture-frame.test", url: fixtures.url("www.fixture-frame.test", "/signin"), framed: true },
    { site: "fixture-pane.test", url: fixtures.url("login.fixture-pane.test", "/login"), pane: true },
  ];
  for (const { site, url, twoStep, framed, pane } of cases) {
    let tab = mine;
    if (pane) {
      tab = await app.call<string>("create", { owner: "conversation:general", url });
      assert.equal(await app.main(`${tabOf(tab)}.holder`), "user");
      await app.page.clickSelector('[data-slot="titlebar-leading"] button');
      await waitBrowser(() => app.main(`Boolean(${tabOf(tab)}.attached && !${tabOf(tab)}.covered)`), "conversation pane page attached");
    } else {
      await app.call("navigate", { id: tab, value: url });
    }
    const contents = `${tabOf(tab)}.view.webContents`;
    const target = framed ? `${contents}.mainFrame.frames[0]` : contents;
    const first = twoStep ? "identifier" : "username";
    const firstInput = `Boolean(document.querySelector('[name=${first}]'))`;
    const pwPage = "location.pathname==='/pw' && Boolean(document.querySelector('[name=password]'))";
    await waitBrowser(() => app.main(`${target}?.executeJavaScript(${JSON.stringify(firstInput)})`), `${site} login page`);
    if (twoStep) {
      await signIn(tab, [[first, username]]);
      await waitBrowser(() => page(tab, pwPage), "password step");
      await signIn(tab, [["password", CANARY]]);
    } else {
      await signIn(tab, [[first, username], ["password", CANARY]], framed);
    }
    await saveBand();
    const top = new URL(url).origin;
    await waitBrowser(async () => (await agent("GET", "/security/signins")).body.data.sites.some(
      (saved: { site: string; entry?: { username: string; origins: string[] } }) =>
        saved.site === site && saved.entry?.username === username && (!framed || saved.entry.origins.includes(top))), `${site} saved entry`);

    await app.call("navigate", { id: tab, value: url });
    await waitBrowser(() => app.main(`${target}?.executeJavaScript(${JSON.stringify(firstInput)})`), `${site} login page again`);
    for (const field of twoStep ? [first, "password"] : [first]) {
      const rect = await app.main<{ x: number; y: number; width: number; height: number }>(`${target}.executeJavaScript(${JSON.stringify(`document.querySelector('[name=${field}]').getBoundingClientRect().toJSON()`)})`);
      if (framed) {
        const offset = await page<{ x: number; y: number }>(tab, "document.querySelector('#login').getBoundingClientRect().toJSON()");
        rect.x += offset.x; rect.y += offset.y;
      }
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      await app.main(`(()=>{const contents=${contents};contents.focus();for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,x:${x},y:${y}})})()`);
      await waitBrowser(() => app.main(`${suggest}?.webContents.executeJavaScript("Boolean(document.querySelector('[role=option]'))")`), `${site} suggestions shown`);
      if (framed) {
        await waitBrowser(async () => {
          const at = await app.main<{ x: number; y: number; page: { x: number; y: number }; zoom: number; list: { x: number; y: number } }>(`(async()=>({...${suggest}.getBounds(),page:${tabOf(tab)}.view.getBounds(),zoom:${contents}.getZoomFactor(),
            list:await ${suggest}.webContents.executeJavaScript("document.querySelector('[data-slot=suggestion-list]').getBoundingClientRect().toJSON()")}))()`);
          return at.y + at.list.y >= at.page.y + (rect.y + rect.height) * at.zoom && Math.abs(at.x + at.list.x - at.page.x - rect.x * at.zoom) <= 8;
        }, "framed suggestion list under the input, at its left edge");
      }
      const option = await app.main<{ x: number; y: number }>(`${suggest}.webContents.executeJavaScript("(()=>{const r=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('owner@fixture.test')).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")`);
      await app.main(`(()=>{const contents=${suggest}.webContents;contents.focus();for(const type of ['mouseDown','mouseUp'])contents.sendInputEvent({type,button:'left',clickCount:1,x:${option.x},y:${option.y}})})()`);
      const filledUser = `document.querySelector('[name=${first}]').value===${JSON.stringify(username)}`;
      const filledPassword = `document.querySelector('[name=password]').value.length===${CANARY.length}`;
      const filled = twoStep ? (field === first ? filledUser : filledPassword) : `${filledUser} && ${filledPassword}`;
      await waitBrowser(() => app.main(`${target}.executeJavaScript(${JSON.stringify(filled)})`), `${site} sign-in filled`);
      await app.main(`(()=>{const contents=${contents};${enter}})()`);
      if (twoStep && field === first) await waitBrowser(() => page(tab, pwPage), "filled username accepted");
    }
    await waitBrowser(() => app.main(`${target}?.executeJavaScript("document.querySelector('h1')?.textContent==='Signed in'")`), `${site} filled sign-in accepted`);

    if (framed) {
      const frame_origin = new URL(fixtures.url("ads.fixture-ads.test", "/")).origin;
      const denied = await agent("POST", "/security/signins/offer", { origin: top, frame_origin, username, password: CANARY + "y" });
      assert.equal(denied.body.data.offer, false);
      const accounts = await agent("POST", "/security/signins/accounts", { origin: top, frame_origin });
      assert.deepEqual(accounts.body.data.accounts, []);
    }
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("document.body.innerText").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally {
  await app.stop(); fixtures.stop(); rmSync(agentHome, { recursive: true, force: true });
}
