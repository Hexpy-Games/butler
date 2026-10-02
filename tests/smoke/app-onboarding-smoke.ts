// Real gateway and DS surfaces with an isolated stub provider; no owner data.
import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createNativeAppServer, writeOnboardingComplete } from "../support/native-app-server.ts";

const server = await createNativeAppServer({ onboardingComplete: false });
const browser = await chromium.launch({ headless: true });
try {
  const now = new Date().toISOString();
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", onboarding: { consent_version: 2, accepted_at: now, completed_at: now } }) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class="new-chat-suggestion"]').first().waitFor();
  const general = page.getByRole("button", { name: "일반", exact: true });
  await general.click();
  assert.equal(await page.locator('[data-test-class="titlebar-title"]').innerText(), "일반", "header shares the sidebar's localized General title");
  await page.getByText("온보딩 시작하기", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-slot="prompt-suggestion-title"]').first().innerText(), "온보딩 시작하기");
  writeOnboardingComplete(server.butlerData);
  await page.reload();
  await page.locator('[data-test-class="new-chat-suggestion"]').first().waitFor();
  assert.equal(await page.locator('[data-test-class="new-chat-suggestion"]').count(), 4);
  assert.equal(await page.getByText("온보딩 시작하기", { exact: true }).count(), 0);
  console.log(JSON.stringify({ ok: true, pendingCards: 1, completedCards: 4, modelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}
