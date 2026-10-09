import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { firstRunStub } from "../support/first-run-stub";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { settleFirstRun } from "../support/first-run-visual";

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

async function capture(page: Page, name: string) {
  await settleFirstRun(page);
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
  assert.equal(geometry.overflow, false, name);
  if (geometry.viewport[0] === 960) {
    assert.equal(geometry.card.width, geometry.intro ? 420 : 520, name);
    assert.equal(geometry.card.x, geometry.intro ? 265 : 215, name);
    assert(Math.abs(geometry.card.y - 85.2) < 1, `${name}: top anchor`);
    if (geometry.intro) { assert.equal(geometry.selectWidth, 386); assert.equal(geometry.buttonWidth, 386); }
    else assert.equal(geometry.titleX, 260, name);
  }
  if (!geometry.intro) {
    assert.equal(await page.locator('[data-slot="setup-step-body"]').getAttribute("data-motion"), "enter", "DS content-key transition");
    assert.equal(await page.locator('[data-slot="setup-step-body"] > :first-child [data-slot="icon-tile"]').count(), 0, "no title icon tile");
    const step = await page.locator("[data-first-run-screen]").getAttribute("data-first-run-screen");
    assert.equal(await page.locator('ol [aria-current="step"]').innerText(), `${step === "consent" ? 2 : step === "ready" ? 4 : 3}\n${firstRunCopy[await page.locator("html").getAttribute("lang") === "ko-KR" ? "ko" : "en"].steps[step as "consent" | "ready" | "connect"]}`);
  }
}

async function reset(page: Page, language: "ko" | "en", theme: "light" | "dark") {
  stub.state.oauthStatus = "pending"; stub.state.holdCommit = false; stub.state.failCommit = false; stub.state.local = false;
  stub.state.readiness = "ready"; stub.state.label = "yeonwoo@example.com";
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme, onboarding: fresh }) });
  await page.reload();
  await page.locator("#first-run-language").selectOption(language);
}

async function reachProviders(page: Page, language: "ko" | "en") {
  const copy = firstRunCopy[language];
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await page.getByRole("button", { name: copy.agree, exact: true }).click();
  await page.locator("#first-run-connect-title").waitFor();
}

async function confirmReady(page: Page, language: "ko" | "en", name: string) {
  const copy = firstRunCopy[language];
  await page.getByRole("heading", { name: copy.readyTitle(name), exact: true }).waitFor();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  assert.equal(await page.getByRole("heading", { name: copy.signInTitle("ChatGPT"), exact: true }).count(), 0);
  const before = await server.api<{ onboarding: { completed_at: string | null } }>("/settings");
  assert.equal(before.onboarding.completed_at, null, "ready still requires explicit completion");
}

async function finish(page: Page, language: "ko" | "en") {
  await page.locator("#first-run-reply-language").selectOption(language === "ko" ? "en" : "ko");
  await page.getByRole("button", { name: firstRunCopy[language].finish, exact: true }).click();
  await page.locator('[data-test-class="workspace"]').waitFor();
  const saved = await server.api<{ onboarding: { completed_at: string | null } }>("/settings");
  assert(saved.onboarding.completed_at, "completion is durable");
  const personalization = await server.api<{ response_language: string }>("/personalization");
  assert.equal(personalization.response_language, language === "ko" ? "en" : "ko");
}

async function signInStates(page: Page, language: "ko" | "en", prefix: string) {
  const copy = firstRunCopy[language];
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByRole("button", { name: copy.signInCopyLink, exact: true }).waitFor();
  await capture(page, `${prefix}-signin-waiting`);
  const opens = await page.evaluate(() => (window as unknown as { signInOpens: string[] }).signInOpens.length);
  await page.getByRole("button", { name: copy.signInReopen, exact: true }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { signInOpens: string[] }).signInOpens.length), opens + 1);
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
  await confirmReady(page, language, "ChatGPT");
  await page.getByText(stub.state.label, { exact: true }).waitFor();
}

async function matrixCase(page: Page, language: "ko" | "en", theme: "light" | "dark") {
  const copy = firstRunCopy[language], prefix = `after-${language}-${theme}`;
  await reset(page, language, theme);
  await capture(page, `${prefix}-welcome`);
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await capture(page, `${prefix}-consent`);
  await page.getByRole("button", { name: copy.back, exact: true }).click();
  await page.locator("#first-run-start").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "first-run-start");
  await reachProviders(page, language);
  await capture(page, `${prefix}-providers`);
  await signInStates(page, language, prefix);
  await capture(page, `${prefix}-ready`);
  await finish(page, language);
  await page.screenshot({ path: join(output, `${prefix}-chat.png`) });
}

async function otherConnection(page: Page, language: "ko" | "en", theme: "light" | "dark", kind: "key" | "local" | "custom") {
  const copy = firstRunCopy[language], prefix = `after-${language}-${theme}`;
  await reset(page, language, theme);
  stub.state.local = kind === "local";
  await reachProviders(page, language);
  if (kind === "key") {
    await page.locator('[data-card-id="claude"]').click();
    await capture(page, `${prefix}-key`);
    await page.locator("#first-run-api-key").fill("stub-api-key-for-smoke");
  } else if (kind === "local") {
    await page.locator('[data-card-id="local"]').click();
    await page.locator('[role="radio"]').waitFor();
    await capture(page, `${prefix}-local`);
    await page.getByRole("button", { name: copy.customConnect, exact: true }).click();
  } else {
    await page.locator('[aria-controls="first-run-more-providers"]').click();
    await page.locator('[data-card-id="other"]').click();
    await capture(page, `${prefix}-custom`);
    const catalog = await server.api<ModelCatalog>("/model-catalog");
    const address = catalog.registered_models.find(model => model.model_ref === "local/stub")!.server_url;
    await page.locator("#first-run-server-url").fill(address!);
    await page.getByRole("button", { name: copy.customConnect, exact: true }).click();
    await page.locator('[role="radio"]').waitFor();
    await capture(page, `${prefix}-custom-models`);
    await page.getByRole("button", { name: copy.customConnect, exact: true }).click();
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
  await page.getByRole("heading", { name: copy.finishing, exact: true }).waitFor();
  assert.equal(await page.locator("#first-run-reply-language").count(), 0, "preparation precedes reply language");
  await capture(page, "after-finishing");
  stub.state.readiness = "ready";
  await confirmReady(page, "ko", "ChatGPT");
  assert.equal(await page.getByText("Smoke profile", { exact: true }).count(), 0, "non-email profile labels are not accounts");
  await capture(page, "after-ready-no-account");
  await finish(page, "ko");
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
  await page.getByRole("button", { name: "설정", exact: true }).click();
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
  const page = app.page;
  await page.addInitScript(() => {
    const state = window as unknown as { signInOpens: string[] };
    state.signInOpens = [];
    window.open = url => { state.signInOpens.push(String(url)); return null; };
  });
  await page.clock.install();
  await page.setViewportSize({ width: 960, height: 710 });
  for (const language of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) await matrixCase(page, language, theme);
  for (const language of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const)
    for (const kind of ["key", "local", "custom"] as const) await otherConnection(page, language, theme, kind);
  await preparationStates(page);
  await renewalAndRerun(page);
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 710 });
    await reset(page, "en", "dark");
    await capture(page, `after-mobile-${width}-welcome`);
    await page.getByRole("button", { name: firstRunCopy.en.start, exact: true }).click();
    await capture(page, `after-mobile-${width}-consent`);
    await page.getByRole("button", { name: firstRunCopy.en.agree, exact: true }).click();
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
