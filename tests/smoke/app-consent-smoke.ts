import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { firstRunCopy } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

const screenshots = resolve(".tmp/consent-smoke");
mkdirSync(screenshots, { recursive: true });
const server = await createNativeAppServer({ onboardingComplete: false });
const browser = await chromium.launch({ headless: true });
const fresh = { consent_version: null, accepted_at: null, completed_at: null };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function screen(page: Page, name: string) {
  await page.locator(`[data-first-run-screen="${name}"]`).waitFor();
}

async function verifyConsent(page: Page, language: "ko" | "en", label: string) {
  const copy = firstRunCopy[language];
  await screen(page, "consent");
  assert(await page.locator('[role="listitem"]').count() === 4, "all four consent items");
  assert(await page.evaluate(() => document.activeElement?.id) === "first-run-consent-title", "heading receives focus");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
  const scroll = page.locator('[data-test-class="setup-wizard-scroll"]');
  assert(await scroll.evaluate((node) => node.scrollTop) === 0, "consent starts at top");
  await page.screenshot({ path: resolve(screenshots, `${label}-consent.png`) });
  await page.keyboard.press("Tab");
  assert(await page.getByRole("link", { name: copy.consentProviderLink }).evaluate((node) => node === document.activeElement), "provider link follows heading");
  assert(await page.getByRole("link", { name: copy.consentProviderLink }).evaluate((node) => node.scrollWidth <= node.clientWidth), "provider link text is not clipped");
  await page.keyboard.press("Tab");
  assert(await page.getByRole("button", { name: copy.decline, exact: true }).evaluate((node) => node === document.activeElement), "Decline follows link");
  await page.keyboard.press("Tab");
  assert(await page.getByRole("button", { name: copy.agree, exact: true }).evaluate((node) => node === document.activeElement), "Agree follows Decline");
  await page.screenshot({ path: resolve(screenshots, `${label}-actions.png`) });
  for (const item of copy.consentItems) assert(await page.getByText(item.body, { exact: true }).count() === 1, "complete consent copy");
}

async function runCase(width: number, language: "ko" | "en", theme: "light" | "dark", renewal: boolean) {
  const completed = "2026-06-01T00:00:00Z";
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme, onboarding: renewal ? { consent_version: 1, accepted_at: completed, completed_at: completed } : fresh }) });
  const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 800 }, locale: language, colorScheme: theme });
  await server.signIn(context);
  const page = await context.newPage();
  const copy = firstRunCopy[language];
  const label = `${width}-${language}-${theme}-${renewal ? "renewal" : "fresh"}`;
  await page.goto(server.url);
  if (!renewal) {
    await screen(page, "welcome");
    await page.screenshot({ path: resolve(screenshots, `${label}-welcome.png`) });
    await page.getByRole("button", { name: copy.start, exact: true }).click();
  }
  await verifyConsent(page, language, label);
  await page.getByRole("button", { name: copy.decline, exact: true }).click();
  await screen(page, "welcome");
  assert(await page.evaluate(() => document.activeElement?.id) === "first-run-start", "Decline focuses Start");
  const before = await server.api<{ onboarding: typeof fresh }>("/settings");
  assert(before.onboarding.consent_version === (renewal ? 1 : null), "Decline saves no agreement");
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await page.getByRole("button", { name: copy.agree, exact: true }).click();
  await screen(page, "connect");
  const saved = await server.api<{ onboarding: { consent_version: number; accepted_at: string; completed_at: string | null } }>("/settings");
  assert(saved.onboarding.consent_version === 2 && Boolean(Date.parse(saved.onboarding.accepted_at)), "agreement durable before connection");
  assert(saved.onboarding.completed_at === (renewal ? completed : null), "agreement preserves completion");
  await page.getByRole("button", { name: copy.back, exact: true }).click();
  await screen(page, "consent");
  await context.close();
}

try {
  let cases = 0;
  for (const width of [320, 375, 1280]) {
    for (const language of ["ko", "en"] as const) {
      for (const theme of ["light", "dark"] as const) {
        for (const renewal of [false, true]) {
          await runCase(width, language, theme, renewal);
          cases += 1;
        }
      }
    }
  }
  console.log(JSON.stringify({ ok: true, cases, screenshots, transport: "browser/native-app", modelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}
