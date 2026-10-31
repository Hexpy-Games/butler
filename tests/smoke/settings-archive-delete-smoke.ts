// test-category: race
// Real built App and preload, with gateway transport stubbed like app-chats-initiated-smoke.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { HARNESS_NAVIGATION } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { installInitiatedGateway, session } from "../support/initiated-fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_ARCHIVE_DELETE_CAPTURES;
const phase = process.env.BUTLER_ARCHIVE_DELETE_PHASE ?? "after";
const pending = "결과물을 옮기는 중입니다. 잠시 후 다시 시도해 주세요.";
const failures: string[] = [];
if (output) mkdirSync(output, { recursive: true });

async function capture(page: Page, name: string) {
  if (!output) return;
  await page.evaluate(() => document.fonts.ready);
  const section = await page.locator('[data-settings-section-id="archives"]').boundingBox();
  assert(section);
  // Narrow real settings screen, from its archive heading through the toast region.
  await page.screenshot({ path: join(output, `${phase}-${name}.png`), animations: "disabled",
    clip: { x: 0, y: Math.max(0, section.y - 70), width: 430, height: 700 - Math.max(0, section.y - 70) } });
}

const browser = await launchSmokeBrowser();
try {
  for (const [language, theme] of [["ko", "light"], ["ko", "dark"], ["en", "light"]] as const) {
    const page = await browser.newPage({ viewport: { width: 430, height: 700 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await installInitiatedGateway(page, language, theme, session([]));
      await page.route("**/canon/mcp-grants*", route => route.fulfill({ json: {
        protocol_version: "butler.app.v1", data: { grants: [] },
      } }));
      const project = { ...HARNESS_NAVIGATION.projects[0]!, id: "archived-project", display_name: "보관한 프로젝트", archived: true };
      const chat = { id: "archived-chat", kind: "chat", title: "보관한 대화", archived: true, last_activity_at: "2026-10-26T21:00:00Z" };
      await page.route("**/archives?*", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: {
        projects: [project], sessions: [chat], pagination: { has_more: false, total: 2, limit: 20, offset: 0 },
      } } }));
      const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
      const openArchives = async () => {
        await page.locator('[data-test-class~="composer-card"]').waitFor();
        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.getByRole("dialog", { name: copy.commandPalette.label });
        await palette.getByRole("combobox").fill(copy.settings.sections.archives);
        await palette.getByRole("option").filter({ hasText: copy.settings.sections.archives }).click();
      };
      await page.goto("http://127.0.0.1:43827/");
      await openArchives();
      const list = page.locator('[data-settings-section-id="archives"]');
      await list.getByText(project.display_name, { exact: true }).waitFor();
      await list.getByText(chat.title, { exact: true }).waitFor();
      if (language === "ko") await capture(page, `${theme}-list`);
      for (const [kind, id, title] of [["projects", project.id, project.display_name], ["sessions", chat.id, chat.title]]) {
        for (const status of [409, 500]) {
          let release!: () => void;
          const held = new Promise<void>(done => { release = done; });
          const path = `**/${kind}/${id}?permanent=true`;
          let deletes = 0;
          await page.route(path, async route => {
            assert.equal(route.request().method(), "DELETE"); deletes++;
            await held;
            await route.fulfill({ status, json: { error: status === 409
              ? { code: "output_transfer_pending", message: pending }
              : { code: "internal_error", message: "Internal database detail must not appear" } } });
          });
          const row = list.getByText(title, { exact: true }).locator(kind === "projects" ? "xpath=../.." : "xpath=../../..");
          const remove = row.getByRole("button", { name: copy.interfaceDetails.delete, exact: true });
          const restore = row.getByRole("button", { name: copy.interfaceDetails.unarchive, exact: true });
          assert.equal(await page.locator("[data-sonner-toast]").count(), 0, "no unrelated toast before deleting");
          try {
            await remove.click();
            await page.getByRole("alertdialog").getByRole("button", { name: copy.common.delete, exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-settings-section-id="archives"] button:disabled'));
            assert(await remove.isDisabled()); assert(await restore.isDisabled());
          } finally { release(); }
          await page.waitForFunction(() => !document.querySelector('[data-settings-section-id="archives"] button:disabled'));
          assert.equal(deletes, 1);
          assert(await list.getByText(title, { exact: true }).isVisible(), "failed delete retains the row");
          assert(await remove.isEnabled()); assert(await restore.isEnabled());
          const expected = status === 409
            ? language === "ko" ? pending : "Outputs are being moved. Please try again shortly."
            : language === "ko" ? "삭제하지 못했습니다." : "Couldn't delete it.";
          const messages = await page.locator('[data-sonner-toast][data-type="error"]').allTextContents();
          if (!messages.includes(expected)) failures.push(`${language}/${theme}/${kind}/${status}: expected toast ${JSON.stringify(expected)}; got ${JSON.stringify(messages)}`);
          if (language === "ko" && kind === "projects") await capture(page, `${theme}-${status}`);
          // Reload through public navigation between attempts, clearing toasts.
          await page.unroute(path);
          await page.reload();
          await openArchives();
          await list.getByText(title, { exact: true }).waitFor();
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.join("\n"));
console.log("PASS archives permanent delete: 12 failures surfaced, rows retained, busy controls released; zero model calls");
