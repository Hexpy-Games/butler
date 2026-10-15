// test-category: race
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";

/** Public settings flow: independent sources, release-only overlay, shared uploads and in-use deletion. */
export async function conversationBackgroundFlow(page: Page, language: "ko" | "en") {
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  const palette = async () => {
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
    await dialog.getByRole("combobox").fill(copy.settings.fields.conversationBackground);
    await dialog.getByRole("option").filter({ hasText: copy.settings.sections.appearance }).click();
  };
  await palette();
  const picker = page.locator('[data-test-class~="settings-conversation-background-picker"]');
  const home = page.locator('[data-test-class~="settings-main-screen-wallpaper-picker"]');
  const tile = (key: string) => picker.locator(`[data-option="${key}"] [role="radio"]`);
  const requests: unknown[] = [];
  const listener = (request: import("playwright").Request) => {
    if (new URL(request.url()).pathname === "/settings" && request.method() === "PATCH") requests.push(request.postDataJSON());
  };
  page.on("request", listener);
  try {
    await tile("live:butler.riso-print").waitFor();
    assert.equal(await picker.locator("#conversation-overlay").count(), 0);
    const homeChoice = await home.locator('[role="radiogroup"]').first().getByRole("radio", { checked: true }).getAttribute("aria-label");
    const tileSaved = page.waitForResponse(response => new URL(response.url()).pathname === "/settings" && response.request().method() === "PATCH");
    await tile("live:butler.bloom").click();
    const slider = picker.locator("#conversation-overlay");
    await slider.waitFor();
    assert.equal(await slider.inputValue(), "70");
    await tileSaved;
    assert.equal(requests.length, 1, "one PATCH for a tile choice");
    requests.length = 0;
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.down("ArrowLeft");
    assert.equal(await slider.inputValue(), "40");
    await page.waitForTimeout(400);
    assert.equal(requests.length, 0, "holding the slider key never writes");
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/settings" && response.request().method() === "PATCH");
    await page.keyboard.up("ArrowLeft"); await saved;
    assert.deepEqual(requests, [{ conversation_background: { overlay: 40 } }]);
    await page.reload(); await page.locator('[data-test-class~="composer-card"]').waitFor(); await palette();
    assert.equal(await picker.locator("#conversation-overlay").inputValue(), "40", "overlay survives reload");
    assert.equal(await home.locator('[role="radiogroup"]').first().getByRole("radio", { checked: true }).getAttribute("aria-label"), homeChoice);
    assert.equal(await home.locator("#conversation-overlay").count(), 0, "Home has no overlay");
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === "/wallpapers" && response.request().method() === "POST");
    await picker.locator('input[type="file"][accept*="image"]').setInputFiles({ name: "conversation.png", mimeType: "image/png",
      buffer: readFileSync("packages/butler-app/client/ui/src/libs/design-system/blocks/WallpaperPicker/posters/butler.riso-print.light.png") });
    const body = await (await uploaded).json();
    const id = (body.data ?? body).id;
    await picker.locator(`[data-option="image:${id}"] [role="radio"][aria-checked="true"]`).waitFor();
    assert.equal(await picker.getByRole("slider", { name: copy.settings.wallpaper.dim, exact: true }).inputValue(), "0");
    const shared = home.locator(`[data-option="image:${id}"]`); await shared.waitFor();
    await shared.getByRole("button", { name: copy.settings.wallpaper.deleteImage }).click();
    await page.getByText(copy.settings.wallpaper.inUse, { exact: true }).waitFor();
  } finally { page.off("request", listener); }
}
