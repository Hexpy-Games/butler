// test-category: race
/**
 * Every web link and sign-in the first-run setup reaches, through the real App: each opens in the user's
 * own browser, never an in-app tab. Links come from the rendered screens and the provider list itself,
 * so a new provider or help link is covered without editing this file. External opens and the OAuth helper are offline stubs.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { PROVIDER_CARDS } from "../../packages/butler-app/client/ui/src/app/setupProviders";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { firstRunStub } from "../support/first-run-stub";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { settleFirstRun } from "../support/first-run-visual";
import { waitBrowser } from "../support/browser-agent-app";

const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);
const evidence = process.env.BUTLER_SMOKE_SCREENSHOTS!;
assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const server = await createNativeAppServer({ onboardingComplete: false });
const stub = await firstRunStub(server);
let app: Awaited<ReturnType<typeof firstRunElectron>> | undefined;
const facts: unknown[] = [];
const firstRunUrl = "https://signin.invalid/first-run";
const keyUrl = "https://aistudio.google.com/apikey";
const helperUrl = "https://signin.invalid/device-auth";

async function assertExternal(label: string, expected: string[]) {
  await waitBrowser(async () => await app!.main<number>("globalThis.externalLinks.length") === expected.length, label);
  assert.deepEqual(await app!.main("globalThis.externalLinks"), expected);
  const tabs = await app!.page.evaluate(async () => {
    const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: unknown[] }> } }).butlerBrowser;
    return (await bridge.call("state")).tabs;
  });
  assert.deepEqual(tabs, [], "authentication never creates an in-app tab");
  facts.push({ label, externalOpens: expected.length, inAppTabs: tabs.length });
}

async function inAppTabs() {
  return await app!.page.evaluate(async () => {
    const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: unknown[] }> } }).butlerBrowser;
    return (await bridge.call("state")).tabs.length;
  });
}

const routes: { screen: string; url: string; route: "external" | "in-app" }[] = [];

/** Clicks every visible web link on the settled screen: `sources` are the URLs the code defines for it, or a count for help links. */
async function clickEveryLink(screen: string, sources: string[] | number) {
  const { page, main } = app!;
  await settleFirstRun(page);
  const links = await page.locator("a[href]").evaluateAll(anchors => anchors
    .filter(anchor => anchor.getClientRects().length > 0 && /^https?:/iu.test((anchor as HTMLAnchorElement).href))
    .map(anchor => ({ attribute: anchor.getAttribute("href")!, url: (anchor as HTMLAnchorElement).href })));
  if (typeof sources === "number") assert.equal(links.length, sources, `${screen}: rendered link count`);
  else assert.deepEqual(links.map(link => link.url).sort(), sources.map(url => new URL(url).href).sort(), `${screen}: rendered links match their sources`);
  for (const { attribute, url } of links) {
    const opens = await main<number>("globalThis.externalLinks.length");
    const tabs = await inAppTabs();
    await page.locator(`a[href=${JSON.stringify(attribute)}]`).click();
    await waitBrowser(async () => await main<number>("globalThis.externalLinks.length") > opens || await inAppTabs() > tabs, `${screen}: ${url} opened`);
    const recorded = await main<string[]>("globalThis.externalLinks");
    routes.push({ screen, url, route: recorded.length === opens + 1 && recorded.at(-1) === url && await inAppTabs() === tabs ? "external" : "in-app" });
  }
}

/** Opens a provider card from the list, expanding "more" when the card sits there. */
async function openCard(cardId: string) {
  const { page } = app!;
  const card = page.locator(`[data-card-id="${cardId}"]`);
  if (!await card.isVisible()) await page.locator('[aria-controls="first-run-more-providers"]').click();
  await card.click();
}

try {
  app = await firstRunElectron(server, stub.url);
  const { page, main } = app;
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  const recorder = `(()=>{"use strict";const shell=${module}('electron').shell;globalThis.externalLinks=[];const record=async url=>{globalThis.externalLinks.push(url)};shell.openExternal=record;return shell.openExternal===record})()`;
  assert.equal(await main<boolean>(recorder), true, "external opens are recorded, never sent to the real browser");
  const copy = getAppCopy("ko-KR");
  await page.locator("#first-run-language").selectOption("ko");
  await clickEveryLink("welcome", 1);
  await page.getByRole("button", { name: copy.firstRun.start, exact: true }).click();
  await page.locator('[data-first-run-screen="consent"]').waitFor();
  await clickEveryLink("consent", 1);
  await page.getByRole("button", { name: copy.firstRun.agree, exact: true }).click();
  await page.locator('[data-memory-choice="off"]').click();
  await clickEveryLink("memory", []);
  await page.getByRole("button", { name: copy.firstRun.memoryChoice.continue, exact: true }).click();
  await page.locator('[data-test-class="first-run-top-cards"]').waitFor();
  await clickEveryLink("providers", []);
  // Every card that is not a browser sign-in (those are checked below), with exactly its own key page.
  for (const spec of Object.values(PROVIDER_CARDS).filter(card => card.kind !== "signin")) {
    await openCard(spec.id);
    await page.locator('[data-test-class="first-run-top-cards"]').waitFor({ state: "detached" });
    await clickEveryLink(`${spec.id} card`, spec.keyUrl ? [spec.keyUrl] : []);
    await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
    await page.locator('[data-test-class="first-run-top-cards"]').waitFor();
  }
  writeFileSync(join(evidence, "first-run-link-routes.json"), JSON.stringify(routes, null, 2));
  assert.deepEqual(routes.filter(route => route.route !== "external"), [], "every first-run link opens in the default browser");
  assert.ok(routes.length > 0);
  facts.push({ label: "first-run links", externalOpens: routes.length, inAppTabs: await inAppTabs() });
  await main("globalThis.externalLinks.length=0");
  await page.locator('[data-card-id="gemini"]').click();
  const keyLink = page.getByRole("link", { name: copy.firstRun.getKey, exact: true });
  for (const theme of ["light", "dark"] as const) {
    await main(`${module}('electron').nativeTheme.themeSource=${JSON.stringify(theme)}`);
    await page.emulateMedia({ colorScheme: theme });
    await settleFirstRun(page);
    await page.screenshot({ path: join(evidence, `first-run-gemini-key-${theme}.png`) });
  }
  await keyLink.focus();
  await page.keyboard.press("Enter");
  await assertExternal("first-run provider key page", [keyUrl]);
  await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByRole("button", { name: copy.firstRun.signInReopen, exact: true }).waitFor();
  await assertExternal("first-run automatic sign-in", [keyUrl, firstRunUrl]);
  await page.screenshot({ path: join(evidence, "first-run-external.png") });
  await page.getByRole("button", { name: copy.firstRun.signInReopen, exact: true }).click();
  await assertExternal("first-run reopen", [keyUrl, firstRunUrl, firstRunUrl]);
  await page.getByRole("button", { name: copy.firstRun.cancel, exact: true }).click();
  // The steps after a connection: reply language, import and ready.
  await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
  await page.locator('[data-test-class="first-run-top-cards"]').waitFor();
  const keyCard = Object.values(PROVIDER_CARDS).find(card => card.kind === "key")!;
  await openCard(keyCard.id);
  await page.locator("#first-run-api-key").fill("stub-test-key");
  await page.getByRole("button", { name: copy.firstRun.next, exact: true }).click();
  await page.locator("#first-run-reply-language:enabled").waitFor();
  await clickEveryLink("reply language", []);
  await page.getByRole("button", { name: copy.firstRun.next, exact: true }).click();
  await page.locator('[data-first-run-screen="import"]').waitFor();
  await clickEveryLink("import", []);
  await page.getByRole("button", { name: copy.firstRun.import.skip, exact: true }).click();
  await page.locator('[data-first-run-screen="ready"]').waitFor();
  await clickEveryLink("ready", []);
  assert.equal(await main<number>("globalThis.externalLinks.length"), 3, "the later steps open nothing");
  facts.push({ label: "reply language, import and ready", externalOpens: 0, inAppTabs: await inAppTabs() });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify(onboardingCompletedPatch(null, new Date().toISOString(), new Date().toISOString())) });
  await page.reload();
  await page.locator('[data-test-class="workspace"]').waitFor();

  // Preserve the real helper stdout/exit path while replacing its provider/network work.
  await main(`(()=>{process.env.BUTLER_NATIVE_AGENT_EXECUTABLE=${JSON.stringify(join(dirname(server.butlerData), "install/bin/butler-agent"))};const cp=process.getBuiltinModule('child_process');const spawn=cp.spawn;
    cp.spawn=function(command,args,options){if(args?.includes('oauth-login')){const child=spawn(process.execPath,
      ['-e',${JSON.stringify(`console.log(${JSON.stringify(helperUrl)});setInterval(()=>{},1000)`)}],
      {...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}});globalThis.providerAuthChild=child;process.once('exit',()=>child.kill('SIGTERM'));return child}return spawn(command,args,options)};
    process.getBuiltinModule('module').syncBuiltinESMExports()})()`);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "모델", exact: true }).click();
  await page.getByText(copy.settings.modelManagement.manageButton, { exact: true }).click();
  await page.getByRole("button", { name: copy.settings.modelManagement.addButton, exact: true }).click();
  await page.locator('[data-test-class="model-add-provider-select"]').click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await page.locator('[data-test-class="hosted-auth-method-select"]').click();
  await page.getByRole("option", { name: copy.settings.modelManagement.codexOauth, exact: true }).click();
  await page.locator("#model-oauth-link").waitFor();
  await assertExternal("Settings helper automatic sign-in", [keyUrl, firstRunUrl, firstRunUrl, helperUrl]);
  await page.screenshot({ path: join(evidence, "settings-external.png") });
  await page.getByRole("button", { name: copy.settings.modelManagement.oauthOpen, exact: true }).click();
  await assertExternal("Settings reopen", [keyUrl, firstRunUrl, firstRunUrl, helperUrl, helperUrl]);
  await page.getByRole("button", { name: copy.settings.modelManagement.oauthRetry, exact: true }).click();
  await assertExternal("Settings re-authenticate", [keyUrl, firstRunUrl, firstRunUrl, helperUrl, helperUrl, helperUrl]);
  await page.evaluate(async () => {
    const bridge = (window as unknown as { butlerApp: { cancelOpenAIOAuthLogin(): Promise<unknown> } }).butlerApp;
    await bridge.cancelOpenAIOAuthLogin();
  });
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(evidence, "acceptance.json"), JSON.stringify({ facts, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, facts, modelCalls: 0 }));
} catch (error) {
  if (app) {
    await app.page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), facts, screen: await app.page.locator("body").innerText().catch(() => "closed") }, null, 2));
  }
  throw error;
} finally {
  await app?.main("globalThis.providerAuthChild?.kill('SIGTERM')").catch(() => {});
  stub.stop(); await app?.stop(); await server.stop();
}
