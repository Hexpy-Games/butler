// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { settleFirstRun } from "./first-run-visual";
import { agentImport } from "./first-run-agent-import";
type FirstRunCopy = ReturnType<typeof getAppCopy>["firstRun"];

/** Exercise the real wizard; persisted connection and completion remain separate. */
export async function substepBackPaths(page: Page, language: string, copy: FirstRunCopy, state: { oauthStatus: string; importRuns: number; importUndos: number; agentSources: string[]; agentRequests: Record<string, unknown>[] }, capture: (page: Page, name: string) => Promise<void>) {
  const languageCopy = () => getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  const next = () => page.getByRole("button", { name: copy.next, exact: true }).click();
  const back = () => page.getByRole("button", { name: copy.back, exact: true }).click();
  await next();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await back();
  await page.getByRole("heading", { name: copy.readyTitle("ChatGPT"), exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: copy.next, exact: true }).isEnabled(), true, "3->2 keeps connection");
  await back();
  await page.locator("#first-run-connect-title").waitFor();
  await settleFirstRun(page);
  assert.match(await page.locator('ol [aria-current="step"]').innerText(), /1\/3/u, "2->1 clears connection");
  state.oauthStatus = "completed";
  await page.locator('[data-card-id="chatgpt"]').click();
  await page.getByRole("heading", { name: copy.readyTitle("ChatGPT"), exact: true }).waitFor();
  await next();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await next();
  await agentImport(page, copy, state, capture, `after-${language}`);
  await back();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await next();
  await page.locator("#first-run-agents-done-title").waitFor();
  assert.equal(await page.getByRole("button", { name: copy.import.skip, exact: true }).count(), 0, "result survives back navigation");
  // Import is one page: its result leads straight to the finish (browsers are imported from Settings).
  await next();
  await page.getByRole("heading", { name: copy.doneTitle, exact: true }).waitFor();
  await page.getByText(copy.summary.agentCounts(1, 3), { exact: true }).waitFor();
  assert.equal(await page.getByText(languageCopy().settings.browserImport.pickFolder, { exact: true }).count(), 0, "no browser import in first run");
  await capture(page, `after-${language}-summary-counts`);
  await back();
  await page.locator("#first-run-agents-done-title").waitFor();
  assert.equal(state.importUndos, 0, "first run never undoes an import");
  await page.locator("#first-run-agents-done-title").waitFor();
  await back();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
}
