// test-category: race
/** Provider authentication through the real App; external opens and OAuth helper are offline stubs. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { firstRunStub } from "../support/first-run-stub";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
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

try {
  app = await firstRunElectron(server, stub.url);
  const { page, main } = app;
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  await main(`(()=>{globalThis.externalLinks=[];${module}('electron').shell.openExternal=async url=>{globalThis.externalLinks.push(url)}})()`);
  const copy = getAppCopy("ko-KR");
  await page.locator("#first-run-language").selectOption("ko");
  await page.getByRole("button", { name: copy.firstRun.start, exact: true }).click();
  await page.getByRole("button", { name: copy.firstRun.agree, exact: true }).click();
  await page.getByRole("button", { name: copy.settings.browserImport.skip, exact: true }).click();
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByRole("button", { name: copy.firstRun.signInReopen, exact: true }).waitFor();
  await assertExternal("first-run automatic sign-in", [firstRunUrl]);
  await page.screenshot({ path: join(evidence, "first-run-external.png") });
  await page.getByRole("button", { name: copy.firstRun.signInReopen, exact: true }).click();
  await assertExternal("first-run reopen", [firstRunUrl, firstRunUrl]);
  await page.getByRole("button", { name: copy.firstRun.cancel, exact: true }).click();
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
  await assertExternal("Settings helper automatic sign-in", [firstRunUrl, firstRunUrl, helperUrl]);
  await page.screenshot({ path: join(evidence, "settings-external.png") });
  await page.getByRole("button", { name: copy.settings.modelManagement.oauthOpen, exact: true }).click();
  await assertExternal("Settings reopen", [firstRunUrl, firstRunUrl, helperUrl, helperUrl]);
  await page.getByRole("button", { name: copy.settings.modelManagement.oauthRetry, exact: true }).click();
  await assertExternal("Settings re-authenticate", [firstRunUrl, firstRunUrl, helperUrl, helperUrl, helperUrl]);
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
