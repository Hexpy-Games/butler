import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";

// Viewer geometry harness, not a unit test. Measure native inline baselines via
// a zero-height inline-block marker beside a computed-style clone.
async function geometry(row: Locator) {
  return row.evaluate((element) => {
    const text = element.querySelector('input, [data-truncate="true"]')!;
    const css = getComputedStyle(text);
    const box = text.getBoundingClientRect();
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;top:0;left:0";
    const clone = text.cloneNode(true) as HTMLElement;
    for (const property of css) clone.style.setProperty(property, css.getPropertyValue(property));
    clone.style.display = "inline-block";
    clone.style.verticalAlign = "baseline";
    if (!(clone instanceof HTMLInputElement)) clone.style.overflow = "visible";
    clone.style.width = `${box.width}px`;
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    wrapper.append(clone, marker); document.body.append(wrapper);
    const baseline = box.top + marker.getBoundingClientRect().top - clone.getBoundingClientRect().top;
    wrapper.remove();
    const rect = element.getBoundingClientRect();
    const number = element.querySelector('[data-slot="icon-slot"]')!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      baseline, textX: box.x, numberX: number.x, numberY: number.y,
      padding: getComputedStyle(element).padding,
      font: [css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing].join("/"),
    };
  });
}

export async function underlineFocus(input: Locator) {
  const result = await input.evaluate((element) => {
    const css = getComputedStyle(element);
    const token = css.getPropertyValue("--focus-ring-width").trim();
    const probe = document.createElement("span");
    probe.style.color = "var(--focus-ring-color)";
    element.parentElement!.append(probe);
    const focusColor = getComputedStyle(probe).color; probe.remove();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      paint.clearRect(0, 0, 1, 1); paint.fillStyle = color; paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data];
    };
    const ancestors: Element[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
    let surface = [255, 255, 255];
    for (const parent of ancestors) {
      const color = rgba(getComputedStyle(parent).backgroundColor), alpha = color[3]! / 255;
      surface = surface.map((channel, i) => channel * (1 - alpha) + color[i]! * alpha);
    }
    const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, channel, i) => {
      const s = channel / 255;
      return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const a = luminance(rgba(css.borderBottomColor)), b = luminance(surface);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (contrast < 3) return `focus contrast ${contrast}:1`;
    if (css.borderBottomColor !== focusColor) return "focus token color missing";
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), frame = parent.getBoundingClientRect();
      if (style.overflowX !== "visible" && (box.left < frame.left - 1 || box.right > frame.right + 1)) return "clipped horizontally";
      if (style.overflowY !== "visible" && (box.top < frame.top - 1 || box.bottom > frame.bottom + 1)) return "clipped";
    }
    return element.matches(":focus-visible") && css.boxShadow === "none" && css.outlineStyle === "none"
      && css.borderTopWidth === "0px" && css.borderLeftWidth === "0px" && css.borderRightWidth === "0px"
      && css.borderBottomWidth === token && css.borderBottomColor !== "transparent" ? "pass" : css.cssText;
  });
  assert.equal(result, "pass", "underline keyboard indicator must be bottom-only and unclipped");
}

export async function auditQuestionSwap(panel: Locator, page: Page, context: string) {
  const row = panel.locator("[data-question-option]").last();
  await row.scrollIntoViewIfNeeded();
  const before = await geometry(row);
  await row.focus(); await page.keyboard.press(String(await panel.locator("[data-question-option]").count()));
  const input = row.locator("input");
  await input.waitFor();
  const compare = async (state: string) => {
    const after = await geometry(row);
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      const a = before[key], b = after[key];
      if (typeof a === "number" && typeof b === "number") assert(Math.abs(a - b) <= 0.02, `${context} ${state} ${key}: ${a} -> ${b}`);
      else assert.equal(b, a, `${context} ${state} ${key}`);
    }
    return after;
  };
  await compare("placeholder"); await underlineFocus(input);
  await input.fill("Hg 직접 입력"); await compare("typing");
  await input.fill("Long custom answer 긴 직접 입력 ".repeat(40)); await compare("long");
  await input.fill(""); await compare("empty");
  await input.fill("Long custom answer 긴 직접 입력 ".repeat(40));
  await page.keyboard.press("Escape"); await compare("back-long");
  await row.focus(); await page.keyboard.press("Enter"); await compare("reopen-long");
  await row.locator("input").fill(""); await page.keyboard.press("Escape");
  const after = await compare("back-empty");
  console.log(`GEOMETRY ${context}: row=${before.height}->${after.height}px baseline=${before.baseline}->${after.baseline}px; all states Δ≤0.02px`);
}
