// Settings > Personalization opened after a Canon view has loaded the profile.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { openCanonBoard, seedCanonBoard } from "./canon-board-scenarios.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";

const profile = { butler_nickname: "알프레드", principal_name: "하늘", preferred_address: "대표님" };

export async function profileAfterCanon(server: NativeAppServerHandle, browser: Browser, screenshots: string): Promise<string> {
  const copy = getAppCopy("ko-KR");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light" }) });
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profile }) });
  await seedCanonBoard(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
  try {
    await server.signIn(context);
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false,
    })));
    await page.goto(server.url, { waitUntil: "load" });
    await openCanonBoard(page);
    // The assignee avatar carries the stored name once the Canon view has loaded the profile.
    await page.locator('[data-test-class="canon-board"]')
      .getByRole("img", { name: copy.canon.personLabel(profile.principal_name, true), exact: true }).first().waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: copy.commandPalette.label });
    await palette.getByRole("combobox").fill(copy.settings.sections.personalization);
    const loaded = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/personalization"));
    await palette.getByRole("option").filter({ has: page.getByText(copy.settings.sections.personalization, { exact: true }) }).first().click();
    await loaded;
    await page.locator("#personalization-profile-principal_name").waitFor();
    for (const [key, value] of Object.entries(profile)) {
      assert.equal(await page.locator(`#personalization-profile-${key}`).inputValue(), value, `${key} shows the stored value`);
    }
    assert.equal(await page.getByRole("button", { name: copy.settings.actions.applyPersonalization, exact: true }).isDisabled(), true,
      "nothing to apply");
    const name = "1280-ko-light-profile-after-canon.png";
    await page.screenshot({ path: resolve(screenshots, name), animations: "disabled" });
    return name;
  } finally { await context.close(); }
}
