import assert from "node:assert/strict";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";

type AuditScope = (screen: string, selector: string) => Promise<void>;
type AuditArrows = (screen: string, steps: number) => Promise<void>;
/** Walk the product composition as well as the DS stories, including the expanded deck. */
export async function auditSessionOrderFocus(page: Page, audit: AuditScope, arrows: AuditArrows) {
  const copy = getAppCopy("ko-KR").canon.order;
  const toggle = page.locator('[data-test-class="session-info-toggle"]');
  await toggle.click();
  const scope = '[data-session-section="order"]';
  const order = page.locator(scope);
  await order.waitFor();
  assert.equal(await order.locator("[data-step-grip]").count(), 2, "one collapsed stack and one single-item grip");
  await audit("session-order-collapsed", scope);
  await order.getByRole("button", { name: copy.deck.expand(2, "자료 조사"), exact: true }).click();
  assert.equal(await order.locator("[data-step-grip]").count(), 3, "every expanded card has its own grip");
  await audit("session-order-expanded", scope);
  await order.getByRole("button", { name: copy.menu("자료 조사"), exact: true }).click();
  await arrows("session-order-menu", await page.getByRole("menuitem").count());
  await page.keyboard.press("Escape");
  await toggle.click();
}
