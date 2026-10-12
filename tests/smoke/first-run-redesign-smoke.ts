// test-category: race
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { createNativeAppServer } from "../support/native-app-server";
import { waitBrowser } from "../support/browser-agent-app";
import { firstRunElectron } from "../support/first-run-electron";
import { firstRunStub } from "../support/first-run-stub";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { substepBackPaths } from "../support/first-run-substeps";
import { settleFirstRun } from "../support/first-run-visual";
import { installIntroProbe, assertIntroIdle } from "../support/first-run-intro";

const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);
const firstRunCopy = { ko: getAppCopy("ko-KR").firstRun, en: getAppCopy("en-US").firstRun };
const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? process.env.TMPDIR ?? "/tmp");
mkdirSync(output, { recursive: true });
const measurements: unknown[] = [];
const fresh = { consent_version: null, accepted_at: null, completed_at: null };
const server = await createNativeAppServer({ onboardingComplete: false });
const stub = await firstRunStub(server);
let app: Awaited<ReturnType<typeof firstRunElectron>> | undefined;

async function externalOpens(): Promise<number> {
  return await app!.main<number>("globalThis.signInOpens.length");
}

async function signInTabs(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const bridge = (window as unknown as { butlerBrowser: { call(op: string): Promise<{ tabs: unknown[] }> } }).butlerBrowser;
    const state = await bridge.call("state");
    return state.tabs.length;
  });
}

async function capture(page: Page, name: string) {
  await settleFirstRun(page);
  assert.equal(await page.locator('[data-morph="run"]').count(), 0, "morph settled");
  assert.equal(await page.locator('[data-test-class="setup-wizard-morph-surface"]').count(), 1, "one DS morph surface");
  assert.equal(await page.locator('[data-test-class="setup-wizard-morph-surface"]:not([hidden])').count(), 0, "morph surface removed at rest");
  if (await page.locator("#first-run-language").count()) {
    assert.equal(await page.locator("[data-setup-mark]").count(), 1, "plain still logo");
    assert.equal(await page.locator("[data-setup-rows]").count(), 1, "five-line intro rows");
  }
  const geometry = await page.evaluate(() => {
    const card = document.querySelector('[data-surface="raised-opaque"]')!;
    const box = card.getBoundingClientRect();
    const title = card.querySelector("h1")!.getBoundingClientRect();
    const intro = Boolean(document.querySelector("#first-run-start"));
    const ancestors = [];
    for (let element: Element | null = card; element; element = element.parentElement) {
      ancestors.push({ tag: element.tagName, class: element.className, scrollLeft: element.scrollLeft,
        x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width, clientWidth: element.clientWidth });
    }
    return { viewport: [innerWidth, innerHeight], card: { x: box.x, y: box.y, width: box.width }, titleX: title.x, intro,
      ancestors,
      selectWidth: document.querySelector("#first-run-language")?.getBoundingClientRect().width,
      buttonWidth: document.querySelector("#first-run-start")?.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  measurements.push({ name, ...geometry });
  writeFileSync(join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: join(output, `${name}.png`) });
  const viewport = page.viewportSize()!;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await settleFirstRun(page);
    const theme = await server.api<{ appearance_theme: string }>("/settings");
    await page.screenshot({ path: join(output, `${name}-${theme.appearance_theme}-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: ${width} overflow`);
  }
  await page.setViewportSize(viewport);
  assert.equal(geometry.overflow, false, name);
  if (geometry.viewport[0] === 960) {
    assert.equal(geometry.card.width, geometry.intro ? 420 : 520, name);
    assert.equal(geometry.card.x, geometry.intro ? 265 : 215, name);
    // Top edge: clamp(titlebar + 16px, 20% of the window, 240px) = 142px at 710px.
    assert(Math.abs(geometry.card.y - 142) < 1, `${name}: top anchor`);
    if (geometry.intro) { assert.equal(geometry.selectWidth, 386); assert.equal(geometry.buttonWidth, 386); }
    else assert.equal(geometry.titleX, 260, name);
  }
  if (!geometry.intro) {
    assert.equal(await page.locator('[data-slot="setup-step-body"]').getAttribute("data-motion"), "enter", "DS content-key transition");
    assert.equal(await page.locator('[data-slot="setup-step-body"] > :first-child [data-slot="icon-tile"]').count(), 0, "no title icon tile");
    const step = await page.locator("[data-first-run-screen]").getAttribute("data-first-run-screen");
    const ids = await page.locator("ol li").count() === 6 ? ["welcome", "consent", "memory", "connect", "import", "ready"] : ["welcome", "consent", "connect", "ready"];
    const lang = await page.locator("html").getAttribute("lang") === "ko-KR" ? "ko" : "en";
    const label = step === "import" ? getAppCopy(lang === "ko" ? "ko-KR" : "en-US").settings.pageSections.import : firstRunCopy[lang].steps[step as "consent" | "memory" | "ready" | "connect"];
    assert.equal(await page.locator('ol [aria-current="step"]').innerText(), `${ids.indexOf(step ?? "") + 1}\n${label}${step === "connect" ? await page.locator("#first-run-reply-language").count() ? " 3/3" : await page.locator("#first-run-connect-title").count() ? " 1/3" : " 2/3" : step === "import" ? await page.locator("#first-run-agents-title").count() ? " 1/2" : " 2/2" : ""}`);
  }
}

async function reset(page: Page, language: "ko" | "en", theme: "light" | "dark") {
  stub.state.oauthStatus = "pending"; stub.state.holdCommit = false; stub.state.failCommit = false; stub.state.local = false;
  stub.state.importEmpty = false; stub.state.readiness = "ready"; stub.state.label = "yeonwoo@example.com"; stub.state.memoryModel = "unset";
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme, onboarding: fresh }) });
  await page.reload();
  await page.locator("#first-run-language").selectOption(language);
}

async function reachProviders(page: Page, language: "ko" | "en", memoryCapture?: string) {
  const copy = firstRunCopy[language];
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await page.getByRole("button", { name: copy.agree, exact: true }).click();
  await passMemory(page, language, memoryCapture);
  await page.locator("#first-run-connect-title").waitFor();
  assert.equal(await page.locator('[data-first-run-screen="import"]').count(), 0, "import follows the AI choice");
}

/** First run asks for the memory model right after consent; renewal goes straight to the AI list. */
async function passMemory(page: Page, language: "ko" | "en", name?: string) {
  const copy = firstRunCopy[language];
  const memory = page.locator('[data-first-run-screen="memory"]');
  await Promise.race([memory.waitFor(), page.locator("#first-run-connect-title").waitFor()]);
  if (!await memory.count()) return;
  const next = page.getByRole("button", { name: copy.memoryChoice.continue, exact: true });
  assert.equal(await next.isDisabled(), true, "a memory choice is required");
  if (name) await capture(page, name);
  await page.locator('[data-memory-choice="off"]').click();
  await next.click();
}

/** First run: the optional import step sits between the AI choice and the finish. */
async function passImport(page: Page, language: "ko" | "en") {
  const copy = firstRunCopy[language];
  for (const [id, title] of [["agents", copy.import.agentsTitle], ["browsers", copy.import.browsersTitle]]) {
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await capture(page, `after-${language}-import-${id}`);
    const skip = page.getByRole("button", { name: copy.import.skip, exact: true });
    const next = page.getByRole("button", { name: copy.next, exact: true });
    await Promise.race([skip.waitFor(), next.waitFor()]);
    await (await next.count() ? next : skip).click();
  }
}

async function confirmReady(page: Page, language: "ko" | "en", name: string, viaImport = true) {
  const copy = firstRunCopy[language];
  if (!await page.locator("#first-run-reply-language").count()) {
    await page.getByRole("button", { name: copy.next, exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: copy.next, exact: true }).click();
  }
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  assert.equal(await page.getByRole("heading", { name: copy.signInTitle("ChatGPT"), exact: true }).count(), 0);
  await capture(page, `after-${language}-reply-${name}`);
  await page.locator("#first-run-reply-language").selectOption(language === "ko" ? "en" : "ko");
  await page.getByRole("button", { name: copy.next, exact: true }).click();
  if (viaImport) await passImport(page, language);
  await page.getByRole("heading", { name: copy.doneTitle, exact: true }).waitFor();
  const before = await server.api<{ onboarding: { completed_at: string | null } }>("/settings");
  assert.equal(before.onboarding.completed_at, null, "ready still requires explicit completion");
}

async function finish(page: Page, language: "ko" | "en") {
  await page.getByRole("button", { name: firstRunCopy[language].finish, exact: true }).click();
  await page.locator('[data-test-class="workspace"]').waitFor();
  const saved = await server.api<{ onboarding: { completed_at: string | null } }>("/settings");
  assert(saved.onboarding.completed_at, "completion is durable");
  const personalization = await server.api<{ response_language: string }>("/personalization");
  assert.equal(personalization.response_language, language === "ko" ? "en" : "ko");
}

async function signInStates(page: Page, language: "ko" | "en", prefix: string) {
  const copy = firstRunCopy[language];
  const before = await externalOpens();
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByRole("button", { name: copy.signInCopyLink, exact: true }).waitFor();
  await capture(page, `${prefix}-signin-waiting`);
  await waitBrowser(async () => await externalOpens() === before + 1, "initial external sign-in");
  const opens = await externalOpens();
  assert.equal(opens, before + 1, "initial sign-in opens externally once");
  assert.equal(await signInTabs(page), 0, "authentication creates no hidden in-app tab");
  await page.getByRole("button", { name: copy.signInReopen, exact: true }).click();
  await waitBrowser(async () => await externalOpens() === opens + 1, "reopen external sign-in");
  assert.equal(await externalOpens(), opens + 1);
  assert.equal(await signInTabs(page), 0, "reopen stays external");
  await page.getByRole("button", { name: copy.signInCopyLink, exact: true }).click();
  await page.getByRole("button", { name: copy.linkCopied, exact: true }).waitFor();
  await page.getByRole("button", { name: copy.cancel, exact: true }).click();
  await page.getByRole("heading", { name: copy.signInCancelled, exact: true }).waitFor();
  await capture(page, `${prefix}-signin-cancelled`);
  assert.equal(await page.getByRole("button", { name: /다른 서비스 고르기|Pick another/u }).count(), 0);
  await page.getByRole("button", { name: copy.retry, exact: true }).click();
  await page.getByRole("button", { name: copy.signInCopyLink, exact: true }).waitFor();
  await page.clock.setSystemTime(Date.now() + 301_000);
  await page.getByRole("heading", { name: copy.signInTimedOut, exact: true }).waitFor();
  await capture(page, `${prefix}-signin-timedout`);
  await page.clock.setSystemTime(Date.now());
  await page.getByRole("button", { name: copy.retry, exact: true }).click();
  stub.state.oauthStatus = "failed";
  await page.getByRole("heading", { name: copy.signInFailed, exact: true }).waitFor();
  await capture(page, `${prefix}-signin-failed`);
  stub.state.oauthStatus = "pending";
  await page.getByRole("button", { name: copy.retry, exact: true }).click();
  await page.getByRole("button", { name: copy.signInCopyLink, exact: true }).waitFor();
  stub.state.holdCommit = true; stub.state.oauthStatus = "completed";
  await page.getByText(copy.connecting, { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: copy.cancel, exact: true }).isDisabled());
  await capture(page, `${prefix}-signin-connecting`);
  stub.state.failCommit = true; stub.state.holdCommit = false;
  await page.getByText(copy.finishFailed, { exact: true }).waitFor();
  await capture(page, `${prefix}-signin-commit-failed`);
  stub.state.failCommit = false;
  await page.getByRole("button", { name: copy.retry, exact: true }).click();
  await page.getByRole("heading", { name: copy.readyTitle("ChatGPT"), exact: true }).waitFor();
  await page.getByText(stub.state.label, { exact: true }).waitFor();
  await capture(page, `${prefix}-signin-connected`);
  await substepBackPaths(page, language, copy, stub.state, capture);
  await confirmReady(page, language, "ChatGPT");
}

async function matrixCase(page: Page, language: "ko" | "en", theme: "light" | "dark") {
  const copy = firstRunCopy[language], prefix = `after-${language}-${theme}`;
  await reset(page, language, theme);
  await capture(page, `${prefix}-welcome`);
  measurements.push({ name: `${prefix}-intro-idle`, ...await assertIntroIdle(page) });
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await capture(page, `${prefix}-consent`);
  await page.getByRole("button", { name: copy.back, exact: true }).click();
  await page.locator("#first-run-start").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "first-run-start");
  await reachProviders(page, language, `${prefix}-memory`);
  await capture(page, `${prefix}-providers`);
  await signInStates(page, language, prefix);
  await capture(page, `${prefix}-ready`);
  await finish(page, language);
  await page.screenshot({ path: join(output, `${prefix}-chat.png`) });
}

async function otherConnection(page: Page, language: "ko" | "en", theme: "light" | "dark", kind: "key" | "local" | "custom") {
  const copy = firstRunCopy[language], prefix = `after-${language}-${theme}`;
  await reset(page, language, theme);
  stub.state.local = kind === "local"; stub.state.localModels = 2;
  stub.state.importEmpty = language === "en" && theme === "dark" && kind === "custom";
  await reachProviders(page, language);
  if (kind === "key") {
    await page.locator('[data-card-id="claude"]').click();
    await capture(page, `${prefix}-key`);
    await page.locator("#first-run-api-key").fill("stub-api-key-for-smoke");
  } else if (kind === "local") {
    await page.locator('[data-card-id="local"]').click();
    await page.locator('[data-model-key]').first().waitFor();
    assert.equal(await page.locator('[data-model-key]').count(), stub.state.localModels, "all detected local models are listed");
    await capture(page, `${prefix}-local`);
    await page.getByRole("button", { name: copy.next, exact: true }).click();
  } else {
    await page.locator('[aria-controls="first-run-more-providers"]').click();
    await page.locator('[data-card-id="other"]').click();
    await capture(page, `${prefix}-custom`);
    const catalog = await server.api<ModelCatalog>("/model-catalog");
    const address = catalog.registered_models.find(model => model.model_ref === "local/stub")!.server_url;
    await page.locator("#first-run-server-url").fill(address!);
    await page.getByRole("button", { name: copy.customConnect, exact: true }).click();
    await page.locator('[data-model-key]').first().waitFor();
    await capture(page, `${prefix}-custom-models`);
    await page.getByRole("button", { name: copy.next, exact: true }).click();
  }
  await confirmReady(page, language, copy.providerNames[kind === "key" ? "claude" : kind === "local" ? "local" : "other"]);
  await capture(page, `${prefix}-ready-${kind}`);
  await finish(page, language);
}
type ModelCatalog = { registered_models: Array<{ model_ref: string; server_url?: string }> };

async function preparationStates(page: Page) {
  const copy = firstRunCopy.ko;
  await reset(page, "ko", "light");
  stub.state.readiness = "failed";
  await page.reload();
  await page.locator('[data-test-class="first-run-prep-failed"]').waitFor();
  assert(await page.locator("#first-run-start").isDisabled(), "failed preparation blocks Start");
  assert.equal(await page.locator("#first-run-start").getAttribute("title"), copy.agreeBlocked);
  await capture(page, "after-preparation-failed");
  stub.state.readiness = "preparing";
  await page.getByRole("button", { name: copy.retry, exact: true }).click();
  await page.locator("#first-run-start:not(:disabled)").waitFor();
  await reachProviders(page, "ko");
  stub.state.label = "Smoke profile"; stub.state.oauthStatus = "profile_exists";
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByText(copy.connecting, { exact: true }).waitFor();
  assert.equal(await page.locator("#first-run-reply-language").count(), 0, "preparation precedes reply language");
  assert.equal(await page.locator('[data-first-run-screen="import"]').count(), 0, "import waits for saved reply language");
  await capture(page, "after-finishing");
  stub.state.readiness = "ready";
  await confirmReady(page, "ko", "ChatGPT");
  assert.equal(await page.getByText("Smoke profile", { exact: true }).count(), 0, "non-email profile labels are not accounts");
  await capture(page, "after-ready-no-account");
  await finish(page, "ko");
}

/** Relaunch with durable consent/connection, then trace every renderer frame from startup. */
async function resumeImport(page: Page) {
  await reset(page, "ko", "light");
  stub.state.local = true; stub.state.localModels = 1;
  await reachProviders(page, "ko");
  await page.locator('[data-card-id="local"]').click();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await page.getByRole("button", { name: firstRunCopy.ko.next, exact: true }).click();
  await page.locator('[data-first-run-screen="import"]').waitFor();
  assert.equal(await page.locator("#first-run-models-title").count(), 0, "single model skips auth picker");
  await capture(page, "before-resume-import");
  await app!.stop();
  stub.state.readiness = "preparing";
  const renderer = mkdtempSync(join(tmpdir(), "first-run-render-probe-"));
  const dist = resolve("packages/butler-app/client/ui/dist");
  cpSync(dist, renderer, { recursive: true });
  writeFileSync(join(renderer, "index.html"), readFileSync(join(dist, "index.html"), "utf8")
    .replace("<head>", '<head><script src="./first-render-probe.js"></script>'));
  writeFileSync(join(renderer, "first-render-probe.js"), `
    window.firstRunFrames = [];
    const sample = () => {
      const step = document.querySelector('[data-first-run-screen]')?.getAttribute('data-first-run-screen');
      if (step && window.firstRunFrames.at(-1) !== step) window.firstRunFrames.push(step);
    };
    new MutationObserver(sample).observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['data-first-run-screen']});
    const paint = () => { sample(); requestAnimationFrame(paint); };
    requestAnimationFrame(paint);
  `);
  try {
    app = await firstRunElectron(server, stub.url, "[data-first-run-screen]", {
      env: { BUTLER_APP_RENDERER_DIST: renderer },
    });
    page = app.page;
    await page.locator("#first-run-reply-language:disabled").waitFor();
    await capture(page, "after-resume-import-preparing");
    stub.state.readiness = "ready";
    await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
    await capture(page, "after-resume-import-ready");
    const frames = await page.evaluate(() => (window as unknown as { firstRunFrames: string[] }).firstRunFrames);
    assert.deepEqual(frames, ["connect"], "saved connection resumes at reply language, including readiness wait");
    measurements.push({ name: "resume-first-render", frames });
    assert.equal((await server.api<{ onboarding: { completed_at: string | null } }>("/settings")).onboarding.completed_at, null);
    await page.getByRole("button", { name: firstRunCopy.ko.back, exact: true }).click();
    await page.getByText(firstRunCopy.ko.keyValid, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: firstRunCopy.ko.next, exact: true }).isEnabled(), true, "resumed model connection survives 3->2");
    await capture(page, "after-resume-model-connected");
    await page.getByRole("button", { name: firstRunCopy.ko.next, exact: true }).click();
    await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  } finally {
    await app?.stop();
    rmSync(renderer, { recursive: true, force: true });
  }
  app = await firstRunElectron(server, stub.url);
  return app.page;
}

/** Settings → Memory carries the first-run switch; the smoke chose off. Light and dark captures. */
async function memorySettings(page: Page) {
  const original = (await server.api<{ appearance_theme: string }>("/settings")).appearance_theme;
  for (const [index, theme] of ["light", "dark", original].entries()) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await page.reload();
    await page.locator('[data-test-class="workspace"]').waitFor();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    if (index === 2) return;
    await page.getByRole("button", { name: "기억", exact: true }).click();
    const section = page.locator('[data-settings-section-id="memory-model"]');
    const toggle = section.getByRole("switch", { name: firstRunCopy.ko.memoryChoice.on, exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "off after the first-run choice");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `after-settings-memory-model-ko-${theme}.png`) });
  }
}

async function renewalAndRerun(page: Page) {
  const copy = firstRunCopy.ko, old = "2026-06-01T00:00:00Z";
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", onboarding: { consent_version: 1, accepted_at: old, completed_at: old } }) });
  await page.reload();
  await page.locator("#first-run-consent-title").waitFor();
  assert.equal(await page.locator("ol").count(), 0, "consent renewal has no step header");
  await page.getByRole("button", { name: copy.decline, exact: true }).click();
  await page.locator("#first-run-start").waitFor();
  await reachProviders(page, "ko");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: { completed_at: old } }) });
  await page.reload();
  await page.locator('[data-test-class="workspace"]').waitFor();
  await memorySettings(page);
  await page.locator("#rerun-setup").click();
  await page.locator("#first-run-start").waitFor();
  await capture(page, "after-rerun");
  const start = await page.locator("#first-run-start").boundingBox(), cancel = await page.getByRole("button", { name: copy.cancel, exact: true }).boundingBox();
  assert(start && cancel && start.x === cancel.x && start.width === cancel.width && cancel.y > start.y);
  await page.getByRole("button", { name: copy.cancel, exact: true }).click();
  await page.locator("#rerun-setup").waitFor();
  assert.equal(await page.locator("#first-run-start").count(), 0, "rerun cancellation returns to Settings");
}

try {
  app = await firstRunElectron(server, stub.url);
  let page = app.page;
  await installIntroProbe(page);
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  await app.main(`(()=>{globalThis.signInOpens=[];${module}('electron').shell.openExternal=async url=>{globalThis.signInOpens.push(url)}})()`);
  await page.clock.install();
  await page.setViewportSize({ width: 960, height: 710 });
  for (const language of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) await matrixCase(page, language, theme);
  for (const language of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const)
    for (const kind of ["key", "local", "custom"] as const) await otherConnection(page, language, theme, kind);
  await preparationStates(page);
  page = await resumeImport(page);
  await renewalAndRerun(page);
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 710 });
    await reset(page, "en", "dark");
    await capture(page, `after-mobile-${width}-welcome`);
    await page.getByRole("button", { name: firstRunCopy.en.start, exact: true }).click();
    await capture(page, `after-mobile-${width}-consent`);
    await page.getByRole("button", { name: firstRunCopy.en.agree, exact: true }).click();
    await page.locator('[data-first-run-screen="memory"]').waitFor();
    await capture(page, `after-mobile-${width}-memory`);
    await passMemory(page, "en");
    await page.locator("#first-run-connect-title").waitFor();
    await capture(page, `after-mobile-${width}-providers`);
  }
  writeFileSync(join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
  assert.equal(server.stubModelCalls.length, 0, "functional checks make no provider calls");
  console.log(JSON.stringify({ ok: true, transport: "Electron 44.5.1 / CDP / native gateway", captures: measurements.length, oauthStarts: stub.state.started, oauthCancels: stub.state.cancelled, modelCalls: 0 }));
} catch (error) {
  if (app) {
    await app.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    console.log(JSON.stringify({ stub: stub.state, screen: await app.page.locator("body").innerText().catch(() => "closed") }));
  }
  throw error;
} finally { stub.state.holdCommit = false; stub.stop(); await app?.stop(); await server.stop(); }
