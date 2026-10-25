import assert from "node:assert/strict";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { probeFocusRing } from "./focus-ring-clipping.ts";

const instructionRows = '[data-test-class="instruction-row"]';
const expandable = '[data-slot="expandable-text"]';
const runField = '[data-setting-id="consolidation-run"]';

/** Sample every animation frame, including text/caption origins and the next row. */
export async function checkInstructionGeometry(page: Page) {
  const first = page.locator(instructionRows).first().locator(expandable);
  await first.scrollIntoViewIfNeeded();
  for (const opening of [true, false]) {
    const samples = await first.evaluate(async (node) => {
      const read = () => {
        const text = node.querySelector('[id^="instruction-text-"]')!;
        const range = document.createRange();
        range.setStart(text.firstChild!, 0); range.setEnd(text.firstChild!, 1);
        return { text: range.getBoundingClientRect().top, caption: node.firstElementChild!.firstElementChild!.getBoundingClientRect().top,
          next: document.querySelectorAll('[data-test-class="instruction-row"]')[1]!.getBoundingClientRect().top,
          scroll: node.closest('[data-test-class="instruction-list"]')!.scrollTop };
      };
      const values = [read()];
      (node as HTMLElement).click();
      for (let index = 0; index < 36; index++) { await new Promise(requestAnimationFrame); values.push(read()); }
      return values;
    });
    assert.equal(await first.getAttribute("aria-expanded"), String(opening));
    for (const sample of samples) {
      assert(Math.abs(sample.text - samples[0]!.text) < 1, "first instruction line stays fixed");
      assert(Math.abs(sample.caption - samples[0]!.caption) < 1, "caption stays fixed");
      assert.equal(sample.scroll, samples[0]!.scroll, "expansion does not jump the list scroll");
    }
    for (let index = 1; index < samples.length; index++) {
      const delta = samples[index]!.next - samples[index - 1]!.next;
      assert(opening ? delta >= -1 : delta <= 1, "following row moves in one direction");
    }
    assert(opening ? samples.at(-1)!.next > samples[0]!.next : samples.at(-1)!.next < samples[0]!.next, "following row actually moves");
  }
}

export async function checkInstructionScroll(page: Page) {
  const list = page.locator('[data-test-class="instruction-list"]');
  const viewport = list;
  assert(await viewport.evaluate(node => node.scrollHeight > node.clientHeight), "instruction list scrolls");
  await viewport.evaluate(node => { node.scrollTop = 80; });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-test-class="instruction-list"]')!;
    return getComputedStyle(node).maskImage !== "none";
  });
  for (const index of [0, 11]) {
    const target = page.locator(instructionRows).nth(index).locator(expandable);
    await target.scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab");
    await target.focus();
    const probe = await probeFocusRing(page);
    assert(probe && !probe.noIndicator && probe.clips.length === 0, `instruction ${index} ring: ${JSON.stringify(probe)}`);
    const trash = page.locator(instructionRows).nth(index).getByRole("button", { name: /삭제|Delete/ });
    await trash.focus();
    const actionProbe = await probeFocusRing(page);
    assert(actionProbe && !actionProbe.noIndicator && actionProbe.clips.length === 0, `delete ring: ${JSON.stringify(actionProbe)}`);
  }
  await list.scrollIntoViewIfNeeded();
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const outer = page.locator('[data-test-class="settings-detail-scroll"]');
  const before = await outer.evaluate(node => node.scrollTop);
  const box = await viewport.boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(before => document.querySelector('[data-test-class="settings-detail-scroll"]')!.scrollTop > before, before);
}

export async function checkTimePicker(page: Page, locale: string) {
  const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").settings.memory;
  const picker = page.locator('[data-slot="time-picker"]');
  await picker.getByRole("button", { name: copy.pickTime }).click();
  const hour = page.locator('[data-time-column="hour"] [aria-selected="true"]');
  await hour.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getTiming().iterations === Infinity || a.playState !== "running"));
  const columns = await page.locator('[data-time-column] [role="listbox"]').evaluateAll(nodes => nodes.map(node => {
    const selected = node.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const css = getComputedStyle(node);
    return { error: Math.abs((selected.top + selected.bottom - box.top - box.bottom) / 2),
      noBar: css.scrollbarWidth === "none" || getComputedStyle(node, "::-webkit-scrollbar").display === "none" };
  }));
  assert(columns.length >= 2 && columns.every(column => column.error < 1 && column.noBar), `time wheels: ${JSON.stringify(columns)}`);
  assert(await hour.evaluate(node => node === document.activeElement), "opening focuses selected hour");
  await page.keyboard.press("ArrowRight");
  assert(await page.locator('[data-time-column="minute"] [aria-selected="true"]').evaluate(node => node === document.activeElement));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await hour.waitFor({ state: "detached" });
  assert(await picker.locator('[data-segment="hour"]').evaluate(node => node === document.activeElement), "Enter returns to hour");
  await page.keyboard.press("Enter");
  await hour.waitFor();
  await page.keyboard.press("Escape");
  await hour.waitFor({ state: "detached" });
  assert(await picker.locator('[data-segment="hour"]').evaluate(node => node === document.activeElement), "Escape returns to hour");
}

export async function checkConsolidationControls(page: Page, locale: string, state: string, fixture: {
  finish: (failed: boolean) => Promise<void>; counts: () => { reads: number; posts: number };
}) {
  const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").settings.memory;
  const field = page.locator(runField);
  const button = field.getByRole("button");
  await page.waitForFunction(() => document.querySelector('[data-setting-id="consolidation-time"] [role="spinbutton"]')?.getAttribute("aria-disabled") !== "true");
  if (state === "consolidation-busy") {
    await page.waitForFunction(() => document.querySelector('[data-setting-id="free-space"] button')?.getAttribute("aria-busy") === "true");
    assert(await button.isDisabled());
    await page.mouse.move(0, 0);
    await button.hover();
    await page.getByRole("tooltip", { name: copy.inUse, exact: true }).waitFor();
    assert.equal(await button.getAttribute("aria-label"), `${copy.runNow}. ${copy.inUse}`);
    assert.equal(fixture.counts().posts, 0);
    return;
  }
  if (state !== "consolidation-scheduled") {
    await page.waitForFunction(() => !(document.querySelector('[data-setting-id="consolidation-run"] button') as HTMLButtonElement)?.disabled);
    assert(await field.getByText(copy.neverRun, { exact: true }).isVisible());
    if (state === "consolidation-idle") {
      const reads = fixture.counts().reads;
      await page.waitForTimeout(1000);
      assert.equal(fixture.counts().reads, reads, "no idle polling");
      assert.equal(fixture.counts().posts, 0);
      return;
    }
    await button.click();
    if (state === "consolidation-race") {
      await page.waitForFunction(() => (document.querySelector('[data-setting-id="consolidation-run"] button') as HTMLButtonElement)?.disabled);
      // The click leaves the pointer inside; approach the disabled control afresh.
      await page.mouse.move(0, 0);
      await button.hover();
      await page.getByRole("tooltip", { name: copy.inUse, exact: true }).waitFor();
      assert.equal(await button.getAttribute("aria-label"), `${copy.runNow}. ${copy.inUse}`);
      assert.equal(fixture.counts().posts, 1);
      return;
    }
  }
  await field.getByRole("button", { name: copy.running, exact: true }).waitFor();
  assert(await button.isDisabled());
  assert.equal(await button.getAttribute("aria-busy"), "true");
  for (const id of ["free-space", "reset-chat-memory", "reset-profile", "reset-project-memory"]) {
    const action = page.locator(`[data-setting-id="${id}"] button`).first();
    assert(await action.isDisabled() || await action.getAttribute("aria-disabled") === "true", `${id} locked during consolidation`);
  }
  if (state === "consolidation-running") return;
  const reads = fixture.counts().reads;
  await fixture.finish(state === "consolidation-failed");
  await page.waitForFunction(() => !(document.querySelector('[data-setting-id="consolidation-run"] button') as HTMLButtonElement)?.disabled);
  assert(fixture.counts().reads > reads, "event refreshes consolidation status");
  assert(!(await field.textContent())?.includes(copy.neverRun));
  if (state === "consolidation-scheduled") {
    assert.equal(await page.getByText(copy.consolidationDone, { exact: true }).count(), 0, "scheduled result is silent");
    assert.equal(fixture.counts().posts, 0);
  } else {
    await page.getByText(state === "consolidation-failed" ? copy.consolidationFailed : copy.consolidationDone, { exact: true }).waitFor();
    assert.equal(fixture.counts().posts, 1);
  }
  if (state === "consolidation-failed") assert.equal(await field.locator('[data-tone="danger"] [data-slot="icon-slot"]').count(), 1);
}
