import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const server = await createNativeAppServer({ onboardingComplete: false, config: { user: { language: "ko", responseLanguage: "en", responseLanguageDefaultSource: "installer" } } });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: "ko-KR" });
  await server.signIn(context);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByLabel("인터페이스 언어").waitFor();
  const copy = getAppCopy("ko-KR").firstRun;
  await page.getByRole("button", { name: copy.start, exact: true }).click();
  await page.getByRole("button", { name: copy.agree, exact: true }).click();
  await page.getByRole("button", { name: "다른 서비스 8개", exact: true }).click();
  await page.locator('[data-card-id="other"]').click();
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await page.locator("#first-run-server-url").fill(config.models.local[0].server_url);
  await page.getByRole("button", { name: "연결", exact: true }).click();
  await page.getByRole("button", { name: "이 모델로 시작", exact: true }).click();
  const select = page.getByLabel("답변 언어", { exact: true });
  await select.waitFor();
  await page.waitForFunction(() => !(document.querySelector("#first-run-reply-language") as HTMLSelectElement)?.disabled);
  const initial = await server.api<{ response_language: string; response_language_explicit: boolean }>("/personalization");
  assert(await select.inputValue() === initial.response_language, "backend default not preselected");
  assert(!initial.response_language_explicit, "derived default was already explicit");
  // Reload while the model is settled: ask once, without reconnecting.
  await page.reload();
  await select.waitFor();
  await select.selectOption("en");
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}`);
  }
  await page.getByRole("button", { name: "시작", exact: true }).click();
  await page.locator('[data-test-class="workspace"]').waitFor();
  await page.locator('[contenteditable="true"]').first().waitFor();
  let view = await server.api<{ response_language: string; response_language_explicit: boolean }>("/personalization");
  assert(view.response_language === "en" && view.response_language_explicit, "reply choice not persisted explicitly");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  view = await server.api("/personalization");
  assert(view.response_language === "en", "interface language overwrote reply choice");
  await page.reload();
  await page.locator('[data-test-class="workspace"]').waitFor();
  assert(await page.locator("#first-run-reply-language").count() === 0, "asked again after explicit choice");
  console.log(JSON.stringify({ ok: true, checks: ["browser-connect-reply-first-chat", "backend-preselection", "resume-without-reconnect", "explicit-persistence", "ui-language-independence", "six-responsive-widths", "ask-once"] }));
} finally {
  await browser.close();
  await server.stop();
}
