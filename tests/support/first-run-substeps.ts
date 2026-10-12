// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { settleFirstRun } from "./first-run-visual";
type FirstRunCopy = ReturnType<typeof getAppCopy>["firstRun"];

/** Exercise the real wizard; persisted connection and completion remain separate. */
export async function substepBackPaths(page: Page, language: string, copy: FirstRunCopy, state: { oauthStatus: string; importRuns: number; importUndos: number; agentSources: string[] }, capture: (page: Page, name: string) => Promise<void>) {
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
  await next();
  await page.locator("#first-run-browsers-title").waitFor();
  await page.locator('[data-import-source="safari"]').click();
  assert.equal(await page.getByRole("button", { name: languageCopy().settings.browserImport.pickFolder, exact: true }).isEnabled(), true);
  await capture(page, `after-${language}-browsers-denied`);
  await page.locator('[data-import-source="chrome:default"]').click();
  await page.getByRole("button", { name: copy.import.importAction, exact: true }).click();
  await page.getByRole("button", { name: copy.next, exact: true }).waitFor();
  await page.getByText(languageCopy().settings.browserImport.result(128, 37, 0, 9, 3), { exact: true }).waitFor();
  await capture(page, `after-${language}-browsers-result`);
  await back();
  await page.locator("#first-run-agents-done-title").waitFor();
  assert.equal(await page.getByRole("button", { name: copy.import.skip, exact: true }).count(), 0, "result survives back navigation");
  await back();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await next();
  await page.locator("#first-run-agents-done-title").waitFor();
  await next();
  await page.locator("#first-run-browsers-title").waitFor();
  await next();
  await page.getByRole("heading", { name: copy.doneTitle, exact: true }).waitFor();
  await page.getByText(copy.summary.agentCounts(2, 5), { exact: true }).waitFor();
  await page.getByText(copy.summary.browserCounts(128, 37), { exact: true }).waitFor();
  await capture(page, `after-${language}-summary-counts`);
  await back();
  await page.locator("#first-run-browsers-title").waitFor();
  const undoBefore = state.importUndos;
  await page.getByRole("button", { name: languageCopy().settings.browserImport.undo, exact: true }).click();
  await page.getByText(languageCopy().settings.browserImport.undone, { exact: true }).waitFor();
  assert.equal(state.importUndos, undoBefore + 1);
  await back();
  await page.locator("#first-run-agents-done-title").waitFor();
  await back();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
}

type ImportState = { importRuns: number; agentSources: string[] };

/** Import ①: tools that hold something start on, the empty one is blocked; Back imports nothing; Next imports the chosen ones. */
async function agentImport(page: Page, copy: FirstRunCopy, state: ImportState, capture: (page: Page, name: string) => Promise<void>, prefix: string) {
  const toggle = (key: string) => page.locator(`[data-agent-import-source="${key}"] [role="switch"]`);
  await page.locator("#first-run-agents-title").waitFor();
  const [runs, imported] = [state.importRuns, state.agentSources.length];
  await toggle("claude-code").and(page.locator('[aria-checked="true"]')).waitFor();
  assert.equal(await toggle("codex").getAttribute("aria-checked"), "true");
  assert.equal(await toggle("opencode").getAttribute("aria-checked"), "false");
  assert.equal(await toggle("opencode").getAttribute("aria-disabled"), "true", "nothing to import: blocked with its reason");
  // The step moves focus to its title once the card settles; take focus after that.
  await settleFirstRun(page);
  await toggle("codex").focus();
  assert.equal(await toggle("codex").evaluate((node) => node === document.activeElement), true, "the switch has focus");
  await page.keyboard.press("Space");
  await toggle("codex").and(page.locator('[aria-checked="false"]')).waitFor({ timeout: 2000 });
  await page.keyboard.press("Space");
  await toggle("codex").and(page.locator('[aria-checked="true"]')).waitFor({ timeout: 2000 });
  await capture(page, `${prefix}-agents-pick`);
  await page.getByRole("button", { name: copy.back, exact: true }).click();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  assert.equal(state.importRuns, runs, "Back imports nothing");
  await page.getByRole("button", { name: copy.next, exact: true }).click();
  await page.locator("#first-run-agents-title").waitFor();
  await page.getByRole("button", { name: copy.next, exact: true }).click();
  await page.locator("#first-run-agents-done-title").waitFor();
  assert.deepEqual(state.agentSources.slice(imported), ["claude-code", "codex"], "both chosen tools, in order");
  await page.getByText(`${copy.import.agentsAdded(1, 3)} · ${copy.import.agentsNeedsKey(1)}`, { exact: true }).waitFor();
  await page.getByText(copy.import.agentsAdded(1, 2), { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /되돌리기|Undo/u }).count(), 0, "no undo in first run");
  await capture(page, `${prefix}-agents-result`);
}
