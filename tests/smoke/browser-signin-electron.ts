// test-category: security
/** P2b signed-in sites in the real App with offline fixtures; stub only, no model calls.
 * Main enforces what Rust decides: grants via a drag, hops refused, open cross-site
 * frames with payment classed, takeover-only fields, keypads, and (keychain opt-in) the fill with a canary. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { hostResolverRules, publicResolverPatch, startSignInFixtures } from "../support/signin-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const CANARY = "canary-pw-77e1d0-electron";
const keychains = process.env.BUTLER_E2E_KEYCHAINS;
const fixtures = startSignInFixtures(CANARY);
// Chromium connects fixture hosts to the local server; everything else resolves normally.
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
let agentHome: string | undefined;
if (keychains) {
  agentHome = mkdtempSync(join(tmpdir(), "signin-agent-home-"));
  mkdirSync(join(agentHome, "Library"), { recursive: true }); mkdirSync(join(agentHome, ".codex"));
  symlinkSync(keychains, join(agentHome, "Library/Keychains"));
}
const app = await browserAgentApp(evidence, () => null, undefined, keychains ? { env: { HOME: agentHome! }, config: { secrets: { store: "system" } } } : {});
type Tab = { id: string; owner: string; holder: string; profile: string; url: string; signinStep?: string };
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})`;
const contents = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
const page = <T>(id: string, code: string) => app.main<T>(`${contents(id)}.executeJavaScript(${JSON.stringify(code)})`);
const state = () => app.call<{ tabs: Tab[] }>("state");
const tabOf = async (id: string) => (await state()).tabs.find(tab => tab.id === id)!;
const admin = () => JSON.parse(readFileSync(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
const results: unknown[] = [];
async function internal(op: string, tab?: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${app.gateway.url}internal/browser/calls`, { method: "POST",
    headers: { ...app.gateway.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" }, body: JSON.stringify({ op, session: "general", tab, args }) });
  const result = await response.json(); results.push({ op, result }); return result as Record<string, any>;
}
async function security(method: string, path: string, body?: unknown) {
  const response = await fetch(`${app.gateway.url}${path.slice(1)}`, { method, headers: { ...app.gateway.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const shop = (path: string) => fixtures.url("www.fixture-shop.test", path);
const refOf = (text: string, pattern: RegExp) => { const ref = pattern.exec(text)?.[1]; assert.ok(ref, `${pattern} in ${text}`); return ref; };

try {
  await app.main(publicResolverPatch(module));
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  await app.call("open");
  // The user signs in in their own tab (form, then MFA): the profile keeps the cookie.
  const mine = await app.call<string>("create", { url: fixtures.url("login.fixture-shop.test", "/login") });
  await waitBrowser(() => page(mine, "Boolean(document.querySelector('input[type=password]'))"), "login page");
  await page(mine, `document.querySelector('[name=username]').value='owner@fixture.test';document.querySelector('[name=password]').value=${JSON.stringify(CANARY)};document.querySelector('form').submit()`);
  await waitBrowser(() => page(mine, "location.pathname==='/mfa'"), "mfa page");
  await page(mine, "document.querySelector('[name=code]').value='123456';document.querySelector('form').submit()");
  await waitBrowser(() => page(mine, "document.body.innerText.includes('Signed in as owner')"), "signed in");
  assert.equal((await tabOf(mine)).profile, "signed_in");
  assert.equal((await internal("tab.observe", mine, { include_image: false })).reason, "not_your_tab", "my tab is never the agent's");

  // Dragging it into the conversation is the grant; the agent then sees the signed-in page.
  await app.call("move", { tabId: mine, toGroupId: "conversation:general", index: 0 });
  await waitBrowser(async () => (await internal("tab.observe", mine, { include_image: false })).status === "ok", "granted by the drag");
  const observed = await internal("tab.observe", mine, { include_image: false });
  assert.ok(JSON.stringify(observed).includes("Signed in as owner"), "cookie echo visible with the grant");
  console.log("grant via drag: signed-in page visible");

  // Every hop to an ungranted site is refused in main; the user's tab is fenced, never closed.
  for (const hop of ["redirect", "link", "post", "frame-top", "refresh", "open"]) {
    await app.call("control", { id: mine, holder: "agent" });
    await app.main(`${contents(mine)}.loadURL(${JSON.stringify(shop(hop === "refresh" ? "/refresh" : "/hops"))})`).catch(() => {});
    await internal("tab.observe", mine, { include_image: false });
    const code = { redirect: "document.querySelector('#redirect').click()", link: "document.querySelector('#link').click()", post: "document.querySelector('#post').submit()",
      "frame-top": "document.querySelector('#frame').contentDocument.querySelector('#top').click()", refresh: "void 0", open: `open(${JSON.stringify(fixtures.url("www.fixture-evil.test", "/collect"))})` }[hop]!;
    await page(mine, code).catch(() => {});
    await new Promise(done => setTimeout(done, 1500));
    const host = new URL(await app.main<string>(`${contents(mine)}.getURL()`)).hostname;
    assert.notEqual(host, "www.fixture-evil.test", `${hop} hop refused`);
    assert.ok(!fixtures.posts.some(post => post.startsWith("www.fixture-evil.test")), `${hop}: nothing reached the ungranted site`);
    console.log(`hop refused: ${hop}`);
  }
  // Control: the same link works once the site is granted, and revoking it fences the live tab.
  await internal("signin.grant", "", { site: "fixture-evil.test" });
  await app.call("control", { id: mine, holder: "agent" });
  await app.main(`${contents(mine)}.loadURL(${JSON.stringify(shop("/hops"))})`);
  await internal("tab.observe", mine, { include_image: false });
  await page(mine, "document.querySelector('#link').click()");
  await waitBrowser(async () => new URL(await app.main<string>(`${contents(mine)}.getURL()`)).hostname === "www.fixture-evil.test", "granted hop navigates");
  assert.equal((await security("POST", "/security/signins/site", { site: "fixture-evil.test", revoke: true })).status, 200);
  await waitBrowser(async () => (await tabOf(mine)).holder === "user", "revocation fences the live tab");
  await app.call("control", { id: mine, holder: "agent" });
  assert.equal((await internal("tab.observe", mine, { include_image: false })).reason, "signed_in_grant_required", "revoked site asks again");
  console.log("hop control: granted site navigates; revoke fences and asks again");

  // Checkout (decision 37): the postcode utility frame and the cross-site ad frame
  // act with no card; the pay widget needs a card on every act; card and password
  // fields are takeover-only in any frame.
  await app.call("control", { id: mine, holder: "agent" });
  await app.main(`${contents(mine)}.loadURL(${JSON.stringify(shop("/checkout"))})`);
  await waitBrowser(async () => { const r = await internal("tab.observe", mine, { include_image: false }); return r.status === "ok" && ["주소 검색", "지금 설치"].every(label => String(r.text).includes(label)); }, "checkout frames");
  const checkout = await internal("tab.observe", mine, { include_image: true });
  const text = String(checkout.text);
  const adFrame = (checkout.frames as Array<{ id: string; url: string; class?: string }>).find(frame => frame.url.includes("fixture-ads.test"))!;
  assert.equal(adFrame.class, "cross_site", JSON.stringify(checkout.frames));
  assert.ok(!text.includes("unavailable"), "no frame is closed");
  const postcode = refOf(text, /button "주소 검색" \[([^\]]+)\]/u);
  const pay = refOf(text, /button "결제하기" \[([^\]]+)\]/u);
  const card = refOf(text, /textbox "Card number" \[([^\]]+)\]/u);
  const prepare = (ref: string, action = "click") => internal("tab.prepare", mine, { observation: checkout.obs, steps: [{ action, ref, ...(action === "fill" ? { value: "4111" } : {}) }] });
  const utility = await prepare(postcode);
  assert.equal(utility.status, "ok", JSON.stringify(utility)); assert.equal(utility.steps[0].frame_payment, false);
  const widget = await prepare(pay);
  assert.equal(widget.status, "ok", JSON.stringify(widget)); assert.ok(widget.steps[0].frame_payment || /tosspayments/u.test(widget.steps[0].hit.frame), "pay widget act is always confirmed");
  const secure = await prepare(card, "fill");
  assert.equal(secure.reason, "secure_field", JSON.stringify(secure)); assert.match(String(secure.recovery), /browser_wait_for_user/u);
  const framePassword = await prepare(refOf(text, /textbox "광고 계정 비밀번호" \[([^\]]+)\]/u), "fill");
  assert.equal(framePassword.reason, "secure_field", `password in a cross-site frame is takeover-only: ${JSON.stringify(framePassword)}`);
  // The cross-site frame needs no grant or card: Rust asks only for payment, upload or payment submit.
  const noCard = (step: Record<string, any>) => !step.frame_payment && !step.upload && !(step.payment && step.submit) && !/stripe|paypal|toss|inicis|nicepay|kakaopay|naverpay/u.test(String(step.hit?.frame));
  const install = refOf(text, /link "지금 설치" \[([^\]]+)\]/u);
  const byRef = await prepare(install);
  assert.equal(byRef.status, "ok", JSON.stringify(byRef)); assert.ok(noCard(byRef.steps[0]), JSON.stringify(byRef.steps[0]));
  assert.equal(byRef.steps[0].hit.frame, "ads.fixture-ads.test", JSON.stringify(byRef.steps[0]));
  const byPoint = await internal("tab.prepare", mine, { observation: checkout.obs, steps: [{ action: "click", point: await adPoint(mine, checkout, install), expect: "link 지금 설치" }] });
  assert.equal(byPoint.status, "ok", `a point into the cross-site frame is open: ${JSON.stringify(byPoint)}`); assert.ok(noCard(byPoint.steps[0]), JSON.stringify(byPoint.steps[0]));
  const acted = await internal("tab.act", mine, { observation: checkout.obs, steps: [{ action: "click", ref: install }], prepared_steps: byRef.steps });
  assert.equal(acted.status, "ok", JSON.stringify(acted)); assert.equal(acted.steps[0].status, "completed", JSON.stringify(acted));
  await waitBrowser(async () => String((await internal("tab.observe", mine, { include_image: false })).text).includes("설치됨"), "click inside the cross-site frame");
  console.log("frames: cross-site frame read and clicked (ref and point) with no card; utility acts; payment confirmed; card and frame password takeover-only");
  // Signed-out conversation tabs: points, fills and keys reach the cross-origin frame too.
  const out = await internal("tab.open", undefined, { url: shop("/checkout") });
  assert.equal(out.status, "ok", JSON.stringify(out));
  await waitBrowser(async () => String((await internal("tab.observe", out.tab, { include_image: false })).text).includes("지금 설치"), "signed-out checkout frames");
  const outside = await internal("tab.observe", out.tab, { include_image: true });
  const outsideRef = refOf(String(outside.text), /link "지금 설치" \[([^\]]+)\]/u);
  const outsideSteps = [{ action: "click", point: await adPoint(out.tab, outside, outsideRef), expect: "link 지금 설치" },
    { action: "fill", ref: refOf(String(outside.text), /textbox "쿠폰" \[([^\]]+)\]/u), value: "AD-1" }, { action: "press", value: "Enter" }];
  const outsidePrepared = await internal("tab.prepare", out.tab, { observation: outside.obs, steps: outsideSteps });
  assert.equal(outsidePrepared.status, "ok", `signed-out frame steps are open: ${JSON.stringify(outsidePrepared)}`);
  for (const step of outsidePrepared.steps) assert.ok(noCard(step), JSON.stringify(step));
  const outsideActed = await internal("tab.act", out.tab, { observation: outside.obs, steps: outsideSteps, prepared_steps: outsidePrepared.steps });
  assert.equal(outsideActed.status, "ok", JSON.stringify(outsideActed));
  await waitBrowser(async () => { const text = String((await internal("tab.observe", out.tab, { include_image: false })).text); return text.includes("설치됨") && text.includes('value="AD-1!"'); }, "point, fill and key inside the signed-out cross-origin frame");
  await internal("tab.close", out.tab);
  console.log("frames: signed-out tab clicks, fills and presses keys in the cross-origin frame with no card");

  // A security keypad answers user_required on every act.
  await internal("signin.grant", "", { site: "fixture-bank.test" });
  await internal("tab.observe", mine, { include_image: false });
  await app.main(`${contents(mine)}.loadURL(${JSON.stringify(fixtures.url("bank.fixture-bank.test", "/"))})`);
  const bank = await internal("tab.observe", mine, { include_image: false });
  assert.ok(String(bank.text).includes("secure keypad"), JSON.stringify(bank));
  const keypad = await internal("tab.prepare", mine, { observation: bank.obs, steps: [{ action: "click", ref: refOf(String(bank.text), /\[([^\]]+)\][^\n]*secure keypad/u) }] });
  assert.equal(keypad.reason, "user_required", JSON.stringify(keypad)); assert.equal(keypad.user_required, "secure_keypad");
  console.log("keypad: user_required");

  if (keychains) await fillFlow();
  else {
    const looked = await internal("signin.lookup", mine);
    assert.equal(looked.reason, "signin_unavailable", "file store only: module off");
    console.log("fill: module off without the system keychain");
  }
  await settingsShots();
  // The canary never reaches main's or the Agent's logs, results or the data folder.
  writeFileSync(join(evidence, "calls.json"), JSON.stringify(results, null, 2));
  for (const text of [JSON.stringify(results), app.gateway.diagnostics()]) assert.ok(!text.includes(CANARY), "canary leaked");
  scan(app.gateway.butlerData);
  console.log("canary absent");
} finally {
  writeFileSync(join(evidence, "calls.json"), JSON.stringify(results, null, 2));
  await app.stop(); fixtures.stop();
  if (agentHome) rmSync(agentHome, { recursive: true, force: true });
}
assert.ok(!readFileSync(join(evidence, "electron.log"), "utf8").includes(CANARY), "canary in the App log");

/** The screenshot point of an observed node inside the checkout's ad frame. */
async function adPoint(tab: string, observation: Record<string, any>, ref: string) {
  const node = (observation.nodes as Array<{ ref: string; rect: { x: number; y: number; width: number; height: number } }>).find(item => item.ref === ref)!;
  const origin = await page<{ x: number; y: number }>(tab, "(()=>{const f=document.querySelector('#ad'),r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop}})()");
  const geometry = observation.image_geometry as { width: number; height: number; cssWidth: number; cssHeight: number };
  return [Math.round((origin.x + node.rect.x + node.rect.width / 2) * geometry.width / geometry.cssWidth), Math.round((origin.y + node.rect.y + node.rect.height / 2) * geometry.height / geometry.cssHeight)];
}

async function fillFlow() {
  const added = await security("POST", "/security/signins", { origin: fixtures.url("login.fixture-shop.test", "").replace(/\/$/u, ""), username: "owner@fixture.test", password: CANARY });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const id = added.body.data.id as string;
  try {
    await security("PATCH", `/security/signins/${id}`, { policy: "always" });
    await app.call("signout", { site: "fixture-shop.test" });
    const opened = await internal("tab.open", undefined, { url: fixtures.url("login.fixture-shop.test", "/login"), signed_in: true });
    assert.equal(opened.status, "ok", JSON.stringify(opened));
    const tab = opened.tab as string;
    const filled = await internal("signin.fill", tab, { entry_id: id });
    assert.deepEqual([filled.status, filled.reason], ["user_required", "mfa"], JSON.stringify(filled));
    assert.equal((await tabOf(tab)).holder, "user", "the MFA step is the user's");
    await page(tab, "document.querySelector('[name=code]').value='123456';document.querySelector('form').submit()");
    await app.call("control", { id: tab, holder: "agent" });
    await waitBrowser(async () => JSON.stringify(await internal("tab.observe", tab, { include_image: false })).includes("Signed in as owner"), "resumed signed in");
    // Same site, another origin: refused before the password is pulled.
    const lookalike = await internal("tab.open", undefined, { url: fixtures.url("files.fixture-shop.test", "/login"), signed_in: true });
    const refused = await internal("signin.fill", lookalike.tab, { entry_id: id });
    assert.equal(refused.status, "origin_mismatch", JSON.stringify(refused));
    assert.ok(!fixtures.posts.includes("files.fixture-shop.test/steal"), "look-alike got nothing");
    await internal("tab.close", lookalike.tab as string);
    console.log("fill: right origin filled, MFA handed over and resumed, look-alike refused");
    await saveOfferFlow();
  } finally { await security("DELETE", `/security/signins/${id}`); }
}

/** "로그인 저장" after the user signs in during a takeover; the password never reaches the renderer. */
async function saveOfferFlow() {
  await app.call("signout", { site: "fixture-shop.test" });
  const opened = await internal("tab.open", undefined, { url: fixtures.url("login.fixture-shop.test", "/login"), signed_in: true });
  const tab = opened.tab as string;
  await app.call("control", { id: tab, holder: "user", sticky: true });
  await page(tab, `document.querySelector('[name=username]').value='owner@fixture.test';document.querySelector('[name=password]').value=${JSON.stringify(CANARY)}`);
  const point = await page<{ x: number; y: number }>(tab, "(()=>{const b=document.querySelector('button').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");
  await app.main(`(()=>{const w=${contents(tab)};w.sendInputEvent({type:'mouseDown',x:${point.x},y:${point.y},button:'left',clickCount:1});w.sendInputEvent({type:'mouseUp',x:${point.x},y:${point.y},button:'left',clickCount:1})})()`);
  await waitBrowser(async () => Boolean((await tabOf(tab) as Tab & { saveOffer?: unknown }).saveOffer), "save offer");
  const snapshot = JSON.stringify(await state());
  assert.ok(!snapshot.includes(CANARY), "the offer never carries the password to the renderer");
  await app.page.expression("document.querySelector('body') && true");
  const saved = await app.call<{ ok: boolean }>("save-signin", { id: tab });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.ok(!(await tabOf(tab) as Tab & { saveOffer?: unknown }).saveOffer, "offer cleared");
  const rows = await security("GET", "/security/signins");
  assert.equal(rows.body.data.sites.find((row: { site: string }) => row.site === "fixture-shop.test").entry.username, "owner@fixture.test");
  console.log("save offer: takeover sign-in saved to the keychain store");
}

async function settingsShots() {
  for (const [locale, theme] of [["ko", "light"], ["ko", "dark"], ["en", "light"], ["en", "dark"]]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.page.reload();
    await app.click(locale === "ko" ? "설정" : "Settings");
    await app.click(locale === "ko" ? "보안" : "Security");
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=sign-in-row]'))"), "sign-in rows");
    await app.page.expression("document.querySelector('[data-test-class=sign-in-row]').scrollIntoView({block:'center'})");
    writeFileSync(join(evidence!, `settings-signins-${locale}-${theme}.png`), await app.page.screenshot());
  }
}

function scan(root: string) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) scan(path);
    else assert.ok(!readFileSync(path).includes(CANARY), `canary in ${path}`);
  }
}
