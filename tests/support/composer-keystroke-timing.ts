import { strict as assert } from "node:assert";
import type { Page } from "playwright";

/** Real input to committed editor DOM, measured through Lexical's mutations. */
export async function installKeystrokeTiming(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]')!;
    const target = window as unknown as { __composerCommitMs: number[] };
    target.__composerCommitMs = [];
    let started: number | undefined;
    editor.addEventListener("beforeinput", () => { started = performance.now(); });
    new MutationObserver(() => {
      if (started === undefined) return;
      target.__composerCommitMs.push(performance.now() - started);
      started = undefined;
    }).observe(editor, { subtree: true, childList: true, characterData: true });
  });
}

export async function readKeystrokeTiming(page: Page, expected: number) {
  const times = await page.evaluate(() => (window as unknown as { __composerCommitMs: number[] }).__composerCommitMs);
  assert.equal(times.length, expected, "every keystroke reaches the editor DOM");
  const sorted = [...times].sort((a, b) => a - b);
  return { samples: times.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
}
