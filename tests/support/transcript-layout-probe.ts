import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

type Sample = { rows: number[][]; scroll: number; reserve: string; height: number };
type ProbeWindow = Window & { __layoutSamples: Sample[]; __layoutFrame: number };

/** Read Lexical paragraphs and line breaks without engine-specific innerText terminators. */
export async function readComposerText(page: Page): Promise<string> {
  return await page.locator('[contenteditable="true"]').evaluate(editor => {
    const text = (node: Node): string => node.nodeType === Node.TEXT_NODE ? node.textContent ?? ""
      : node.nodeName === "BR" ? "\n" : Array.from(node.childNodes).map(text).join("");
    return Array.from(editor.childNodes).map(text).join("\n");
  });
}

/** Sample actual transcript geometry on every rendered frame, including input frames. */
export async function assertTypingLayout(page: Page, browser: string): Promise<void> {
  const editor = page.locator('[contenteditable="true"]');
  const folder = process.env.BUTLER_SMOKE_SCREENSHOTS;
  if (folder) mkdirSync(folder, { recursive: true });
  for (const lines of [1, 2, 4]) {
    const draft = Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join("\n");
    await editor.fill(draft);
    await editor.press("ControlOrMeta+End");
    await page.waitForTimeout(300);
    if (folder) await page.screenshot({ path: join(folder, `${browser}-${lines}-before.png`) });
    await page.evaluate(() => {
      const target = window as unknown as ProbeWindow;
      target.__layoutSamples = [];
      const tick = () => {
        const scroll = document.querySelector('[data-test-class~="conversation-scroll"]') as HTMLElement;
        const card = document.querySelector('[data-test-class="composer-card"]')!;
        target.__layoutSamples.push({
          rows: Array.from(document.querySelectorAll('[data-test-class~="message-list"] > article')).map(node => {
            const rect = node.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
          scroll: scroll.scrollTop, reserve: getComputedStyle(scroll).getPropertyValue("--composer-reserve"),
          height: card.getBoundingClientRect().height,
        });
        target.__layoutFrame = requestAnimationFrame(tick);
      };
      tick();
    });
    await editor.pressSequentially(" typing probe", { delay: 100 });
    const samples = await page.evaluate(() => {
      const target = window as unknown as ProbeWindow;
      cancelAnimationFrame(target.__layoutFrame);
      return target.__layoutSamples;
    });
    assert(samples.length > 10 && samples[0].rows.length > 0, "real transcript frames sampled");
    const shifts = samples.filter(sample => JSON.stringify(sample) !== JSON.stringify(samples[0]));
    console.log(JSON.stringify({ browser, lines, frames: samples.length, shifts: shifts.length,
      first: samples[0], changed: shifts[0] }));
    assert.equal(shifts.length, 0, `${browser}: zero transcript shifts per keystroke at ${lines} lines`);
    assert.equal(await readComposerText(page), `${draft} typing probe`, "complete multiline draft retained");
    if (folder) await page.screenshot({ path: join(folder, `${browser}-${lines}-after.png`) });
  }
}
