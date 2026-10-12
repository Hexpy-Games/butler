// test-category: security
/** Saved card and autofill fills in the real App with offline fixtures; stub only, no model calls.
 * Main types the values with native text input into cc-* fields, a PG-style
 * cross-origin iframe with split Korean card fields and a PG pop-up; a keypad
 * and a 3-D Secure frame hand the tab to the user; a look-alike origin and a
 * replayed token are refused; observations hide and screenshots mask the
 * filled fields; the canary card number appears nowhere. The fill needs the
 * system keychain (opt-in `BUTLER_E2E_KEYCHAINS`, test-only service, deleted). */
import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser } from "../support/browser-agent-stub";
import { PROFILE, SIGNUP_FIELDS, ID_FIELDS, ID_LABELS } from "../support/autofill-fixtures";
import { hostResolverRules, publicResolverPatch, startPayFixtures } from "../support/pay-fixtures";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const CARD = { number: "4000056655665556", month: "12", year: "2030", cvc: "737", name: "HONG GILDONG", pin2: "12", owner: "900101" };
const CANARY = CARD.number;
const keychains = process.env.BUTLER_E2E_KEYCHAINS;
const fixtures = startPayFixtures(CARD);
process.env.BUTLER_SMOKE_ELECTRON_ARGS = JSON.stringify([...JSON.parse(process.env.BUTLER_SMOKE_ELECTRON_ARGS ?? "[]"), hostResolverRules()]);
let agentHome: string | undefined;
if (keychains) {
  agentHome = process.env.HOME; assert.ok(agentHome);
  assert.equal(keychains, join(agentHome, "Library/Keychains"), "use the provisioned isolated keychain HOME");
  mkdirSync(join(agentHome, ".codex"), { recursive: true });
}
const stub = browserStub();
const app = await browserAgentApp(evidence, stub.handler, undefined,
  keychains ? { env: { HOME: agentHome!, BUTLER_USER_AUTH: "deny" }, config: { secrets: { store: "system" } } } : {}).catch(error => { fixtures.stop(); if (agentHome) rmSync(agentHome, { recursive: true, force: true }); throw error; });
type Tab = { id: string; owner: string; holder: string; url: string; opener?: string; payStep?: string };
const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})`;
const subject = "globalThis.browserAgentSubject";
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
const originOf = (url: string) => new URL(url).origin;
async function open(path: string) {
  const opened = await internal("tab.open", undefined, { url: shop(path) });
  assert.equal(opened.status, "ok", JSON.stringify(opened));
  return opened.tab as string;
}
async function close(tab: string) {
  if ((await tabOf(tab))?.holder === "user") await app.call("control", { id: tab, holder: "agent" });
  // The gateway sees the hand-back once main publishes it.
  await waitBrowser(async () => (await internal("tab.close", tab)).reason !== "user_control", "tab closed");
  await waitBrowser(async () => !(await tabOf(tab)), "tab gone");
}
const refOf = (text: string, pattern: RegExp) => { const ref = pattern.exec(text)?.[1]; assert.ok(ref, `${pattern} in ${text}`); return ref; };

try {
  await app.main(publicResolverPatch(module));
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  await app.call("open");
  if (keychains) {
    if (process.env.BUTLER_SMOKE_VAULT_SCOPE === "profile") await profileFlows();
    else await fillFlows();
  }
  else {
    const tab = await open("/checkout-cc");
    assert.equal((await internal("pay.lookup", tab)).reason, "vault_unavailable", "file store only: module off");
    await close(tab);
    console.log("vault: off without the system keychain");
    await settingsShots();
  }
  writeFileSync(join(evidence, "calls.json"), JSON.stringify(results, null, 2));
  for (const text of [JSON.stringify(results), app.gateway.diagnostics()]) for (const canary of [CANARY, PROFILE.passport_number, PROFILE.birth_date]) assert.ok(!text.includes(canary), "canary leaked");
  scan(app.gateway.butlerData);
  console.log("canary absent");
} finally {
  writeFileSync(join(evidence, "calls.json"), JSON.stringify(results, null, 2));
  await app.stop(); fixtures.stop();
  if (agentHome) rmSync(agentHome, { recursive: true, force: true });
}
assert.ok(!readFileSync(join(evidence, "electron.log"), "utf8").includes(CANARY), "canary in the App log");
assert.ok(!readFileSync(join(evidence, "agent.log"), "utf8").includes(CANARY), "canary in the Agent log");

async function fillFlows() {
  const added = await security("POST", "/security/vault/cards", { nickname: "Everyday card", number: CARD.number.replace(/(\d{4})/gu, "$1 ").trim(),
    exp_month: Number(CARD.month), exp_year: Number(CARD.year), cvc: CARD.cvc, holder_name: CARD.name, pin2: CARD.pin2, owner_id: CARD.owner });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const id = added.body.data.id as string;
  // Record the tokens main pulls with, to replay one.
  await app.main(`(()=>{const b=${subject};if(b.__payTokens)return;b.__payTokens=[];const pull=b.pullVault;b.pullVault=(token,...rest)=>{b.__payTokens.push(token);return pull(token,...rest)}})()`);
  try {
    await checkoutFlow(id);
    await pgFrameFlow(id);
    await handOffFlows(id);
    await popupFlow(id);
    await profileFlows();
    // Settings with a saved card: masked number, allowed sites, reveal denied by the harness.
    await settingsShots();
  } finally { await security("DELETE", `/security/vault/cards/${id}`); }
}

async function checkoutFlow(id: string) {
  const tab = await open("/checkout-cc");
  const inspected = await internal("pay.inspect", tab, { kind: "card" });
  assert.equal(inspected.status, "ok", JSON.stringify(inspected));
  assert.equal(inspected.amount, "59,800원");
  assert.deepEqual([...inspected.fields].sort(), ["cvc", "expiry", "name", "number"]);
  const looked = await internal("pay.lookup", tab);
  assert.equal(looked.cards[0].last4, "5556", JSON.stringify(looked));
  // A look-alike top-level origin is refused before any token.
  const lookalike = originOf(fixtures.url("files.fixture-shop.test", "/"));
  const refused = await internal("pay.fill", tab, { item_id: id, top_origin: lookalike, frame_origins: [] });
  assert.equal(refused.status, "origin_mismatch", JSON.stringify(refused));
  const filled = await internal("pay.fill", tab, { item_id: id, top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
  assert.equal(filled.status, "filled", JSON.stringify(filled));
  assert.deepEqual([...filled.filled].sort(), ["cvc", "expiry", "name", "number"]);
  // The token was single use.
  const token = (await app.main<string[]>(`${subject}.__payTokens`)).at(-1);
  const replay = await fetch(`${app.gateway.url}internal/browser-host/vault/${token}`, { method: "POST",
    headers: { ...app.gateway.authHeaders, "x-butler-admin": admin(), "content-type": "application/json" },
    body: JSON.stringify({ origin: inspected.top_origin, frame_origins: [inspected.top_origin] }) });
  assert.equal(replay.status, 410, "token reuse refused");
  // Observations hide the filled fields and screenshots mask them.
  const observed = await internal("tab.observe", tab, { include_image: true });
  assert.equal(String(observed.text).match(/filled from saved item \(hidden\)/gu)?.length, 4, String(observed.text));
  assert.ok(!JSON.stringify(observed).includes(CANARY));
  await maskedPixels(observed, "checkout");
  const shot = await internal("tab.screenshot", tab, { observation: observed.obs });
  assert.ok(!JSON.stringify(shot).includes(CANARY));
  // Native text input reached the page: the merchant got the exact card.
  await app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("document.forms[0].submit()")`);
  await waitBrowser(async () => fixtures.verdicts.some(item => item.startsWith("www.fixture-shop.test/paid:")), "merchant verdict");
  assert.ok(fixtures.verdicts.includes("www.fixture-shop.test/paid:ok"), JSON.stringify(fixtures.verdicts));
  await close(tab);
  console.log("checkout: cc-* fields filled natively; look-alike and replay refused; hidden and masked");
}

async function pgFrameFlow(id: string) {
  const tab = await open("/checkout-pg");
  const pg = originOf(fixtures.url("js.tosspayments.com", "/"));
  await waitBrowser(async () => (await internal("pay.inspect", tab, { kind: "card" })).status === "ok", "pg frame fields");
  const inspected = await internal("pay.inspect", tab, { kind: "card" });
  assert.deepEqual(inspected.frame_origins, [pg], JSON.stringify(inspected));
  assert.equal(inspected.amount, "32,000원");
  // Fields in a frame outside the binding are never filled.
  const unbound = await internal("pay.fill", tab, { item_id: id, top_origin: inspected.top_origin, frame_origins: [] });
  assert.equal(unbound.status, "no_fields", JSON.stringify(unbound));
  const filled = await internal("pay.fill", tab, { item_id: id, top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
  assert.equal(filled.status, "filled", JSON.stringify(filled));
  assert.deepEqual([...filled.filled].sort(), ["exp_month", "exp_year", "number", "owner_id", "pin2"]);
  const observed = await internal("tab.observe", tab, { include_image: false });
  assert.ok(!JSON.stringify(observed).includes(CANARY) && !JSON.stringify(observed).includes(CARD.owner));
  await app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.mainFrame.frames.find(f=>f.url.includes("tosspayments")).executeJavaScript("document.forms[0].submit()")`);
  await waitBrowser(async () => fixtures.verdicts.some(item => item.startsWith("js.tosspayments.com/approve:")), "pg verdict");
  assert.ok(fixtures.verdicts.includes("js.tosspayments.com/approve:ok"), JSON.stringify(fixtures.verdicts));
  await close(tab);
  console.log("pg frame: split card fields, month/year selects, PIN and birth date filled in the cross-origin frame");
}

async function handOffFlows(id: string) {
  const keypad = await open("/checkout-keypad");
  await waitBrowser(async () => (await internal("pay.inspect", keypad, { kind: "card" })).status === "ok", "keypad frame");
  const inspected = await internal("pay.inspect", keypad, { kind: "card" });
  const result = await internal("pay.fill", keypad, { item_id: id, top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
  assert.deepEqual([result.status, result.reason], ["user_required", "secure_keypad"], JSON.stringify(result));
  assert.deepEqual(result.filled, ["number"]);
  const held = await tabOf(keypad);
  assert.deepEqual([held.holder, held.payStep], ["user", "secure_keypad"], "the keypad is the user's");
  await close(keypad);
  const acs = await open("/checkout-3ds");
  await waitBrowser(async () => (await internal("tab.observe", acs, { include_image: false })).status === "ok", "3ds page");
  const challenge = await internal("pay.inspect", acs, { kind: "card" });
  assert.deepEqual([challenge.status, challenge.reason], ["user_required", "three_ds"], JSON.stringify(challenge));
  assert.equal((await tabOf(acs)).holder, "user");
  await close(acs);
  console.log("hand-off: keypad after the number, 3-D Secure before any field");
}

async function popupFlow(id: string) {
  const tab = await open("/checkout-popup");
  const observed = await internal("tab.observe", tab, { include_image: false });
  const steps = [{ action: "click", ref: refOf(String(observed.text), /button "결제창 열기" \[([^\]]+)\]/u) }];
  const prepared = await internal("tab.prepare", tab, { observation: observed.obs, steps });
  assert.equal(prepared.status, "ok", JSON.stringify(prepared));
  await internal("tab.act", tab, { observation: observed.obs, steps, prepared_steps: prepared.steps });
  let popup = "";
  await waitBrowser(async () => { popup = (await state()).tabs.find(item => item.opener === tab)?.id ?? ""; return Boolean(popup); }, "pg pop-up");
  await waitBrowser(async () => (await internal("pay.inspect", popup, { kind: "card" })).status === "ok", "pop-up fields");
  const inspected = await internal("pay.inspect", popup, { kind: "card" });
  assert.equal(inspected.merchant_origin, originOf(shop("/")), JSON.stringify(inspected));
  assert.equal(inspected.top_origin, originOf(fixtures.url("stdpay.inicis.com", "/")));
  const filled = await internal("pay.fill", popup, { item_id: id, top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
  assert.equal(filled.status, "filled", JSON.stringify(filled));
  await app.main(`${subject}.tabs.get(${JSON.stringify(popup)}).view.webContents.executeJavaScript("document.forms[0].submit()")`);
  await waitBrowser(async () => fixtures.verdicts.some(item => item.startsWith("stdpay.inicis.com/paid:")), "pop-up verdict");
  assert.ok(fixtures.verdicts.includes("stdpay.inicis.com/paid:ok"), JSON.stringify(fixtures.verdicts));
  await close(tab);
  console.log("pop-up: the PG window opened for the agent and was filled natively");
}

/** The observation image is black over every field Butler filled. */
async function maskedPixels(observed: Record<string, any>, name: string, count = 4) {
  const data = observed.image?.data as string; assert.ok(data, "observation image");
  writeFileSync(join(evidence!, `${name}-observation.jpg`), Buffer.from(data, "base64"));
  const geometry = observed.image_geometry as { width: number; height: number; cssWidth: number; cssHeight: number };
  const points = (observed.nodes as Array<{ vault?: boolean; rect: { x: number; y: number; width: number; height: number } }>).filter(node => node.vault)
    .map(node => [(node.rect.x + node.rect.width / 2) * geometry.width / geometry.cssWidth, (node.rect.y + node.rect.height / 2) * geometry.height / geometry.cssHeight]);
  assert.equal(points.length, count, "all filled fields");
  const dark = await app.main<boolean[]>(`(()=>{const {nativeImage}=${module}('electron');const image=nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(data)},"base64"));const width=image.getSize().width,bitmap=image.toBitmap();
    return ${JSON.stringify(points)}.map(([x,y])=>{const n=(Math.round(y)*width+Math.round(x))*4;return bitmap[n]<48&&bitmap[n+1]<48&&bitmap[n+2]<48})})()`);
  assert.ok(dark.every(Boolean), `masked: ${JSON.stringify(dark)}`);
}

async function browserSettings(locale: string) {
  await app.click(locale === "ko" ? "설정" : "Settings");
  const label = locale === "ko" ? "브라우저" : "Browser";
  const scope = '[data-test-class="settings-navigation-scroll"] button';
  await waitBrowser(() => app.page.expression(`Array.from(document.querySelectorAll(${JSON.stringify(scope)})).some(node=>node.textContent?.trim()===${JSON.stringify(label)})`), "settings browser navigation");
  await app.page.clickText(label, scope);
}

async function settingsShots() {
  for (const [locale, theme] of [["ko", "light"], ["ko", "dark"], ["en", "light"], ["en", "dark"]]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.page.reload();
    await browserSettings(locale!);
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('#payment-methods,[data-test-class=vault-card-add]'))"), "payment methods");
    await app.page.expression("(document.querySelector('[data-test-class=vault-card-row]') ?? document.querySelector('[data-test-class=vault-card-add]')).scrollIntoView({block:'center'})");
    writeFileSync(join(evidence!, `settings-payment-${locale}-${theme}.png`), await app.page.screenshot());
  }
}

function scan(root: string) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) scan(path);
    else for (const canary of [CANARY, PROFILE.passport_number, PROFILE.birth_date]) assert.ok(!readFileSync(path).includes(canary), `canary in ${path}`);
  }
}

async function profileFlows() {
  const added = await security("POST", "/security/vault/profiles", PROFILE);
  assert.equal(added.status, 200);
  const id = added.body.data.id as string;
  let family = "";
  try {
    const second = await security("POST", "/security/vault/profiles", { nickname: "Family", name: "Family Person" });
    assert.equal(second.status, 200); family = second.body.data.id;
    const listed = await security("GET", "/security/vault");
    assert.equal(listed.body.data.profiles.length, 2, "multiple profiles");
    await profileApproval(id);
    for (const [path, fields] of [["/signup", SIGNUP_FIELDS], ["/identity", ID_FIELDS]] as const) {
      const tab = await open(path);
      const looked = await internal("pay.lookup", tab);
      assert.ok(!JSON.stringify(looked).includes(PROFILE.email), "lookup never returns profile values");
      const observed = await internal("tab.observe", tab, { include_image: false });
      const targets = fields.map(field => {
        const node = observed.nodes.find((item: { name: string }) => item.name === (ID_LABELS[field] ?? field));
        assert.ok(node, `ref for ${field}`); return { ref: node.ref, field };
      });
      const inspected = await internal("pay.inspect", tab, { kind: "profile", targets });
      assert.equal(inspected.status, "ok", JSON.stringify(inspected));
      if (path === "/signup") await incompatibleProfileTargets(tab, id, targets, inspected);
      if (path === "/identity") await changedProfileTarget(tab, id, targets, inspected);
      const filled = await internal("autofill.fill", tab, { item_id: id, targets, top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
      assert.equal(filled.status, "filled", JSON.stringify(filled));
      assert.deepEqual([...filled.filled].sort(), [...fields].sort());
      assert.deepEqual(filled.missing, []);
      const hidden = await internal("tab.observe", tab, { include_image: true });
      assert.equal(String(hidden.text).match(/filled from saved item \(hidden\)/gu)?.length, fields.length);
      assert.ok(!JSON.stringify(hidden).includes(PROFILE.passport_number));
      await maskedPixels(hidden, path.slice(1), fields.length);
      await app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("document.forms[0].submit()")`);
      await waitBrowser(async () => fixtures.verdicts.includes(`${path}/submit:ok`), "complete profile form verdict");
      await close(tab);
    }
    const denied = await security("POST", `/security/vault/profiles/${id}/reveal`, { locale: "ko" });
    assert.equal(denied.status, 403, "passport reveal needs OS authentication");
    await profileShots();
  } finally {
    if (family) await security("DELETE", `/security/vault/profiles/${family}`);
    await security("DELETE", `/security/vault/profiles/${id}`);
  }
  console.log("profile: signup/address and identity forms complete; values hidden/masked; reveal denied; two profiles");
}

async function profileShots() {
  await app.main(`${winExpression()}.setContentSize(1440,1440)`);
  for (const theme of ["light", "dark"]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    await app.page.reload(); await browserSettings("ko");
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=vault-profile-row]'))"), "profile section");
    const summary = await app.page.expression<string>("document.querySelector('[data-test-class=vault-profile-row]').textContent");
    assert.ok(summary.includes("Sample Person · 입력할 때마다 확인") && summary.includes("여권 ••••") && !summary.includes("저장됨:"), "separate profile name, policy and masked passport");
    await app.page.expression("document.querySelector('[data-test-class=vault-profile-row]').scrollIntoView({block:'center'})");
    writeFileSync(join(evidence!, `settings-profile-ko-${theme}.png`), await app.page.screenshot());
    await app.click("Self");
    await app.page.clickText("수정", '[role="menuitem"]');
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=vault-profile-form]'))"), "profile edit form");
    assert.equal(await app.page.expression("document.querySelector('[data-test-class=vault-profile-id] [aria-expanded]').getAttribute('aria-expanded')"), "false");
    const labels = await app.page.expression<string[]>("Array.from(document.querySelectorAll('[data-test-class=vault-profile-form] [data-slot=field-label]')).map(el=>el.textContent)");
    assert.deepEqual(labels.slice(0, 17), ["프로필 이름", "전체 이름", "성", "이름", "영문 성", "영문 이름", "전화", "이메일", "국가", "우편번호", "시/도", "시/군/구", "주소", "상세 주소", "소속", "생년월일", "성별"]);
    assert.equal(await app.page.expression("Array.from(document.querySelectorAll('[data-test-class=vault-profile-form] input')).every(el=>Boolean(document.querySelector('label[for=\"'+el.id+'\"]')) && !el.getAttribute('placeholder'))"), true);
    await app.page.expression("(()=>{const form=document.querySelector('[data-test-class=vault-profile-form]');form.scrollIntoView({block:'start'});for(let el=form.parentElement;el;el=el.parentElement){if(el.scrollHeight>el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)){el.scrollTop-=32;break}}})()");
    writeFileSync(join(evidence!, `settings-profile-edit-ko-${theme}.png`), await app.page.screenshot());
    await app.click("신분증 (선택)");
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=vault-profile-form]').getAnimations({subtree:true}).every(a=>a.playState!=='running' || a.effect?.getComputedTiming().iterations===Infinity)"), "ID section expanded");
    assert.equal(await app.page.expression("document.querySelector('[data-test-class=vault-profile-id] [aria-expanded]').getAttribute('aria-expanded')"), "true");
    assert.deepEqual(await app.page.expression<string[]>("Array.from(document.querySelectorAll('[data-test-class=vault-profile-id] [data-slot=field-label]')).map(el=>el.textContent)"), ["여권 번호", "여권 만료일", "국적", "발급 국가"]);
    await app.page.expression("document.querySelector('[data-test-class=vault-profile-id]').scrollIntoView({block:'center'})");
    writeFileSync(join(evidence!, `settings-profile-id-ko-${theme}.png`), await app.page.screenshot());
    await app.click("취소");
  }
}
function winExpression() { return `${module}('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://butler/'))`; }

async function profileApproval(id: string) {
  const tab = await open("/identity");
  const observed = await internal("tab.observe", tab, { include_image: false });
  const fields = ["birth_date", "passport_number"];
  const targets = fields.map(field => ({ ref: observed.nodes.find((node: { name: string }) => node.name === ID_LABELS[field]).ref, field }));
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["native:browser_autofill_fill"] } }),
    () => bridgeBrowser("browser_autofill_fill", { tab, profile_id: id, targets }),
  ]);
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "Fill saved identity fields", client_message_id: crypto.randomUUID() }) });
  let request: Record<string, any> = {};
  await waitBrowser(async () => {
    const view = await app.gateway.api<{ requests: Record<string, any>[] }>("/authority-requests?session_id=general");
    request = view.requests.find(item => item.approval?.operation?.tool === "browser_autofill_fill") ?? {};
    return Boolean(request.request_ref);
  }, "profile approval");
  assert.ok(request.approval.operation.targets.includes(fields.join(", ")));
  await app.click("일반");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-authority-decision]'))"), "approval card visible");
  const card = await app.page.expression<string>("document.querySelector('[data-test-class=composer-authority-decision]').textContent");
  for (const field of fields) assert.ok(card.includes(field), "approval lists each sensitive field kind");
  await profileApprovalShots(fields);
  await app.gateway.api(`/authority-requests/${request.request_ref}/allow?session_id=general`, { method: "POST", body: JSON.stringify({ scope: "once" }) });
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "approved fill delivered");
  await close(tab);
}

async function profileApprovalShots(fields: string[]) {
  const sizes = await app.main<{ minimum: number[]; content: number[] }>(`({ minimum: ${winExpression()}.getMinimumSize(), content: ${winExpression()}.getContentSize() })`);
  try {
    await app.main(`${winExpression()}.setMinimumSize(320,320)`);
    for (const theme of ["light", "dark"]) {
      await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
      await app.page.reload();
      await app.click("일반");
      await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-authority-decision]'))"), "approval card visible");
      await app.main(`${winExpression()}.setContentSize(1440,900)`);
      await app.shot(`autofill-approval-${theme}`);
      await app.main(`${winExpression()}.setContentSize(390,844)`);
      await waitBrowser(() => app.page.expression("innerWidth === 390"), "mobile viewport");
      await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=composer-authority-decision]').getAnimations({subtree:true}).every(a=>a.playState!=='running' || a.effect?.getComputedTiming().iterations===Infinity)"), "approval layout settled");
      const card = await app.page.expression<string>("document.querySelector('[data-test-class=composer-authority-decision]').textContent");
      for (const field of fields) assert.ok(card.includes(field));
      assert.equal(await app.page.expression("document.documentElement.scrollWidth <= innerWidth"), true);
      await app.shot(`autofill-approval-phone-${theme}`);
    }
  } finally {
    await app.main(`${winExpression()}.setMinimumSize(...${JSON.stringify(sizes.minimum)});${winExpression()}.setContentSize(...${JSON.stringify(sizes.content)})`);
  }
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "light" }) });
}

async function incompatibleProfileTargets(tab: string, id: string, targets: { ref: string; field: string }[], inspected: Record<string, any>) {
  for (const target of targets.filter(target => ["email", "organization"].includes(target.field))) {
    for (const field of ["passport_number", "birth_date", "rrn"]) {
      for (const op of ["pay.inspect", "autofill.fill"]) {
        const denied = await internal(op, tab, { kind: "profile", item_id: id, targets: [{ ref: target.ref, field }],
          top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
        assert.equal(denied.reason, "incompatible_target", JSON.stringify(denied));
        if (op === "pay.inspect") assert.deepEqual(denied.targets, [{ ref: target.ref, field, detected: target.field === "email" ? "email" : null }]);
        assert.ok(denied.recovery.includes("Observe"));
      }
    }
  }
  assert.equal(await app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("Array.from(document.querySelectorAll('input')).every(input=>!input.value)")`), true);
}

async function changedProfileTarget(tab: string, id: string, targets: { ref: string; field: string }[], inspected: Record<string, any>) {
  for (const [attribute, value] of [["autocomplete", "email"], ["autocomplete", "street-address"], ["type", "email"], ["inputmode", "email"], ["autocomplete", PROFILE.passport_number]]) {
    const change = (value: string | null) => app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript(${JSON.stringify(`document.querySelector('[name=document]').${value === null ? `removeAttribute('${attribute}')` : `setAttribute('${attribute}','${value}')`}`)})`);
    await change(value!);
    for (const op of ["pay.inspect", "autofill.fill"]) {
      const denied = await internal(op, tab, { kind: "profile", item_id: id, targets,
        top_origin: inspected.top_origin, frame_origins: inspected.frame_origins });
      assert.equal(denied.reason, "incompatible_target", "recheck compatibility after approval");
      assert.ok(!JSON.stringify(denied).toLowerCase().includes(PROFILE.passport_number.toLowerCase()), "classification never returns raw autocomplete text");
    }
    assert.equal(await app.main(`${subject}.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("Array.from(document.querySelectorAll('input')).every(input=>!input.value)")`), true);
    await change(null);
  }
}
