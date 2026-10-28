import { strict as assert } from "node:assert";
import { runSmokeCases } from "./smoke-browser.ts";
import { auditCanonCardFocus } from "./canon-registration-cards.ts";
import type { Locator, Page } from "playwright";

/** Keep capturing every variant, then report all failures without retrying. */
export async function runMcpMatrix(cases: string[], variable: string, entry: string) {
  if (process.env[variable]) {
    assert(cases.includes(process.env[variable]!));
    return false;
  }
  const failures: unknown[] = [];
  for (const cell of cases) {
    try { await runSmokeCases([cell], variable, entry, { isolate: true }); }
    catch (error) { console.error(error); failures.push(error); }
  }
  assert.equal(failures.length, 0, "All MCP matrix variants must pass");
  return true;
}

/** Focus failures must not discard the remaining owner-review images. */
export function mcpFocusAudit(page: Page) {
  const failures: unknown[] = [];
  return {
    async audit(surface: Locator) {
      try { await auditCanonCardFocus(page, surface); }
      catch (error) { console.error(error); failures.push(error); }
    },
    finish() { assert.equal(failures.length, 0, "MCP surfaces must have zero clipped focus rings"); },
  };
}

export async function assertAssigneeLayout(detail: Locator) {
  const row = detail.locator('[data-test-class="key-value-row"]').filter({ has: detail.page().getByRole("combobox", { name: "담당", exact: true }) });
  const select = row.getByRole("combobox", { name: "담당", exact: true });
  const avatar = await row.getByRole("img").boundingBox();
  const control = await select.boundingBox();
  const caption = await row.getByText("연우 · Claude Code 작업 중", { exact: true }).boundingBox();
  assert(avatar && control && caption);
  assert(Math.abs(avatar.y + avatar.height / 2 - control.y - control.height / 2) < 1, "Avatar and select are vertically centered");
  assert(caption.y >= control.y + control.height, "Agent caption is below the select");
  assert(Math.abs(caption.x + caption.width - control.x - control.width) < 1, "Agent caption is right aligned under the select");
}
