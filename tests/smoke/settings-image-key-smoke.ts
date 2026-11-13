// Real native gateway, stub provider: saving an image-model API key selects it without any model call.
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const server = await createNativeAppServer({ env: { BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0" } });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
type ImageSettings = { models: { model_ref: string; provider_id: string; display_name: string }[]; selected: { model_ref: string; credential_id: string } | null };
async function openModels(page: Page) {
  await page.locator('[data-test-class="mac-window"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("모델");
  await palette.getByRole("option").filter({ hasText: "모델" }).first().click();
  await palette.waitFor({ state: "detached" });
}
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", wallpaper: { source: { kind: "none" } } }) });
  const model = (await server.api<ImageSettings>("/settings/image-model")).models.find(m => m.provider_id === "openai");
  assert(model, "an openai image model is listed");
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await server.signIn(page);
  await page.goto(server.url);
  await openModels(page);
  const section = page.locator('[data-settings-section-id="image-models"]');
  await section.getByRole("combobox").first().click();
  await page.getByRole("option", { name: model.display_name, exact: true }).click();
  await page.locator("#hosted-credential-label").fill("image smoke");
  await page.locator("#hosted-api-key").fill("sk-smoke-fake-key");
  const saved = page.waitForResponse(r => r.url().includes("/settings/image-model") && r.request().method() === "PUT");
  await section.getByRole("button", { name: "추가", exact: true }).click();
  assert((await saved).ok(), "image model PUT succeeds");
  assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0, "no error toast");
  await page.reload();
  await openModels(page);
  await page.locator("#hosted-api-key-masked").waitFor();
  assert((await section.getByRole("combobox").nth(1).innerText()).includes("image smoke"));
  const selected = (await server.api<ImageSettings>("/settings/image-model")).selected;
  const key = (await server.api<{ credentials: { id: string; label: string }[] }>("/credentials")).credentials.find(c => c.label === "image smoke");
  assert.equal(selected?.model_ref, model.model_ref);
  assert(key && selected?.credential_id === key.id, "saved key is the selected credential");
  assert.equal(await section.getByText("API 키", { exact: true }).filter({ visible: true }).count(), 1);
  assert.equal(server.stubModelCalls.length, 0);
  await section.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "커스텀 모델 추가", exact: true }).click();
  await page.locator("#custom-image-name").fill("Custom smoke");
  await page.locator("#custom-image-endpoint").fill("http://127.0.0.1:9999/v1");
  await page.locator("#custom-image-model").fill("smoke-image");
  await page.locator("#custom-image-key").fill("custom-smoke-key");
  const added = page.waitForResponse(r => r.url().endsWith("/settings/image-model/custom") && r.request().method() === "POST");
  await section.getByRole("button", { name: "저장", exact: true }).click();
  assert((await added).ok());
  await section.getByRole("button", { name: "삭제", exact: true }).waitFor();
  assert((await section.getByRole("combobox").first().innerText()).includes("Custom smoke"));
  await section.getByRole("combobox").first().click();
  await page.getByRole("group", { name: "커스텀", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert((await server.api<ImageSettings>("/settings/image-model")).selected?.model_ref.startsWith("custom-image/"));
  const deleted = page.waitForResponse(r => r.url().includes("/settings/image-model/custom/") && r.request().method() === "DELETE");
  await section.getByRole("button", { name: "삭제", exact: true }).click();
  assert((await deleted).ok());
  await page.waitForFunction(() => !document.querySelector("#custom-image-name"));
  assert.equal((await server.api<ImageSettings>("/settings/image-model")).selected, null);
  assert.equal(server.stubModelCalls.length, 0);
  console.log("image key and custom model: selected, persisted and deleted");
} finally { await browser?.close(); await server.stop(); }
process.exit(0);
