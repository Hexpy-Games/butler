import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { computerFixtures } from "./computers-fixtures.ts";

export async function auditComputersFocus(page: Page, audit: (screen: string, selector: string) => Promise<void>) {
  const copy = getAppCopy("ko-KR");
  await page.getByRole("button", { name: copy.sidebar.settings }).first().click();
  await page.getByRole("button", { name: copy.settings.sections.security, exact: true }).click();
  const scope = '[data-settings-section-id="computers"]';
  const section = page.locator(scope);
  const remove = section.getByRole("button", { name: copy.computers.removeComputer(computerFixtures[0]!.name), exact: true });
  await remove.waitFor();
  await audit("settings-computers", scope);
  await section.getByRole("button", { name: copy.computers.add, exact: true }).click();
  await audit("computer-add-dialog", '[role="dialog"]');
  await page.keyboard.press("Escape");
  await remove.click();
  await audit("computer-delete-dialog", '[role="alertdialog"]');
  await page.keyboard.press("Escape");
}
