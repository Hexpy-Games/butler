// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { settleFirstRun } from "./first-run-visual";
type FirstRunCopy = ReturnType<typeof getAppCopy>["firstRun"];
type ImportState = { importRuns: number; agentSources: string[]; agentRequests: Record<string, unknown>[] };

/**
 * Import: tools that hold something start picked, the empty one is blocked; one page per chosen tool with
 * every item on; Back walks the pages and imports nothing; the last page imports only what stays on.
 */
export async function agentImport(page: Page, copy: FirstRunCopy, state: ImportState, capture: (page: Page, name: string) => Promise<void>, prefix: string) {
  const text = copy.import;
  // DS pick cards: the whole card is a checkbox with a check on the right, no switches.
  const tool = (key: string) => page.locator(`[data-agent-import-source="${key}"][role="checkbox"]`);
  const item = (name: string) => page.locator(`[data-agent-import-item="${name}"][role="checkbox"]`);
  const next = () => page.getByRole("button", { name: copy.next, exact: true }).click();
  /** The card morph briefly shows the leaving and arriving pages; wait for one page with this progress. */
  const onPage = async (name: string, index: number) => {
    await page.getByText(text.agentItemsProgress(name, index, 2), { exact: true }).waitFor();
    await settleFirstRun(page);
  };
  const back = () => page.getByRole("button", { name: copy.back, exact: true }).click();
  await page.locator("#first-run-agents-title").waitFor();
  assert.equal(await page.locator('[data-first-run-screen] [role="switch"]').count(), 0, "no switches on the import step");
  const [runs, requests] = [state.importRuns, state.agentRequests.length];
  await tool("claude-code").and(page.locator('[aria-checked="true"]')).waitFor();
  assert.equal(await tool("codex").getAttribute("aria-checked"), "true");
  assert.equal(await tool("opencode").getAttribute("aria-disabled"), "true", "nothing to import: blocked with its reason");
  // The step moves focus to its title once the card settles; take focus after that.
  await settleFirstRun(page);
  await tool("codex").focus();
  await page.keyboard.press("Space");
  await tool("codex").and(page.locator('[aria-checked="false"]')).waitFor({ timeout: 2000 });
  await page.keyboard.press("Space");
  await tool("codex").and(page.locator('[aria-checked="true"]')).waitFor({ timeout: 2000 });
  await capture(page, `${prefix}-agents-pick`);
  await back();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await next();
  await page.locator("#first-run-agents-title").waitFor();
  await next();
  await page.getByRole("heading", { name: text.agentItemsTitle("Claude Code"), exact: true }).waitFor();
  await onPage("Claude Code", 1);
  for (const name of ["instructions", "github", "files", "search"]) assert.equal(await item(name).getAttribute("aria-checked"), "true", `${name} starts on`);
  await page.getByText(`${text.itemServer} · ${text.itemNeedsKey}`, { exact: true }).first().waitFor();
  await item("search").click();
  await capture(page, `${prefix}-agent-items-claude`);
  await next();
  await onPage("Codex", 2);
  assert.equal(await item("instructions").getAttribute("aria-disabled"), "true", "unreadable instruction file: blocked with its reason");
  await item("linear").click();
  await back();
  await onPage("Claude Code", 1);
  assert.equal(await item("search").getAttribute("aria-checked"), "false", "choices survive Back");
  await back();
  await page.locator("#first-run-agents-title").waitFor();
  assert.equal(state.importRuns, runs, "Back imports nothing");
  await next();
  await onPage("Claude Code", 1);
  await next();
  await onPage("Codex", 2);
  assert.equal(await item("linear").getAttribute("aria-checked"), "false");
  await capture(page, `${prefix}-agent-items-codex`);
  await page.getByRole("button", { name: text.importAction, exact: true }).click();
  await page.locator("#first-run-agents-done-title").waitFor();
  assert.deepEqual(state.agentRequests.slice(requests), [
    { source: "claude-code", instructions: true, servers: ["github", "files"] },
    { source: "codex", instructions: false, servers: ["sentry"] },
  ], "only the items left on, tool by tool");
  await page.getByText(`${text.agentsAdded(1, 2)} · ${text.agentsNeedsKey(1)}`, { exact: true }).waitFor();
  await page.getByText(`${text.agentsAdded(0, 1)} · ${text.agentsNeedsKey(1)}`, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /되돌리기|Undo/u }).count(), 0, "no undo in first run");
  await capture(page, `${prefix}-agents-result`);
}
