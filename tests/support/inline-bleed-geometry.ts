// test-category: race
import { strict as assert } from "node:assert";
import type { Locator } from "playwright";
import { probeFocusRing } from "./focus-ring-clipping.ts";

/** Recover the original layout slot from the bleed margins, without pinned coordinates. */
export async function inlineBleedGeometry(target: Locator) {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect(), css = getComputedStyle(element);
    const top = parseFloat(css.marginTop), bottom = parseFloat(css.marginBottom);
    const content = element.firstElementChild!.getBoundingClientRect();
    const text = element.querySelector("h3, p")!;
    const range = document.createRange(); range.selectNodeContents(text);
    const y = range.getClientRects()[0]!.y;
    const slot = { y: box.y - top, height: box.height + top + bottom };
    // Every sibling row or control between the field and the detail root, however deep the field sits.
    const root = element.closest('[data-test-class="canon-epic-detail"]')!;
    const neighbours: Element[] = [];
    for (let node = element.parentElement!; root.contains(node); node = node.parentElement!) {
      neighbours.push(...Array.from(node.children).filter(child => !child.contains(element)));
    }
    const overlaps = neighbours.map(node => {
      const rect = node.getBoundingClientRect();
      const width = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
      const height = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
      return width > 0 && height > 0 ? width * height : 0;
    });
    const slotBottom = slot.y + slot.height;
    const nextY = Math.min(...neighbours.map(node => node.getBoundingClientRect().y).filter(top => top >= slotBottom));
    const clipping = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const x = /hidden|auto|scroll|clip/u.test(style.overflowX);
      const vertical = /hidden|auto|scroll|clip/u.test(style.overflowY);
      const shape = style.clipPath !== "none" || style.maskImage !== "none";
      if (x || vertical || shape) clipping.push({ slot: node.getAttribute("data-slot"),
        clearance: Math.min(...(x || shape ? [box.left - 2 - rect.left - node.clientLeft,
          rect.left + node.clientLeft + node.clientWidth - box.right - 2] : []),
        ...(vertical || shape ? [box.top - 2 - rect.top - node.clientTop,
          rect.top + node.clientTop + node.clientHeight - box.bottom - 2] : [])) });
    }
    return { y, height: box.height, fillY: box.y, slot, nextY,
      padding: parseFloat(css.paddingTop), baselineHeight: parseFloat(css.getPropertyValue("--clickable-min-height")),
      expectedTextY: slot.y + (slot.height - content.height) / 2 + y - content.y,
      overlap: Math.max(0, ...overlaps), clipping };
  });
}

export async function verifyInlineBleed(target: Locator) {
  const measured = await inlineBleedGeometry(target);
  const bleed = await target.getAttribute("data-bleed");
  const baseline = await target.evaluate(element => {
    element.setAttribute("data-bleed", "inline");
  }).then(() => inlineBleedGeometry(target)).finally(() => target.evaluate((element, value) => {
    if (value === null) element.removeAttribute("data-bleed");
    else element.setAttribute("data-bleed", value);
  }, bleed));
  assert.equal(measured.y, baseline.y, "Block bleed preserves the first-line text y");
  assert.equal(measured.fillY, baseline.fillY - measured.padding);
  assert.equal(measured.height, baseline.height + 2 * measured.padding);
  assert.equal(measured.nextY, baseline.nextY, "Block bleed preserves the next row y");
  assert.equal(measured.fillY, measured.slot.y - measured.padding);
  assert.equal(measured.height, measured.slot.height + 2 * measured.padding);
  assert.equal(measured.y, measured.expectedTextY, "First-line text remains centered in the original slot");
  assert(Number.isFinite(measured.nextY), "A row follows the field");
  assert.equal(measured.overlap, 0, "The enlarged fill does not overlap neighbouring rows");
  for (const clip of measured.clipping) assert(clip.clearance >= 0, JSON.stringify(clip));
  return measured;
}

export async function verifyInlineKeyboardRing(trigger: Locator) {
  const page = trigger.page();
  await trigger.focus();
  await page.keyboard.press("Shift+Tab");
  // Focusing the preceding control can insert controls (for example an expanded composer).
  for (let stop = 0; stop < 50; stop++) {
    await page.keyboard.press("Tab");
    if (await trigger.evaluate(element => element === document.activeElement)) break;
  }
  assert(await trigger.evaluate(element => element === document.activeElement && element.matches(":focus-visible")));
  const ring = await probeFocusRing(page);
  assert(ring && !ring.noIndicator, "Keyboard focus paints a ring");
  assert.deepEqual(ring.clips, []);
}
