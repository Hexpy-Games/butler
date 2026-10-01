import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";

// Viewer geometry harness, not a unit test. Measure native inline baselines via
// a zero-height inline-block marker beside a computed-style clone.
async function geometry(row: Locator) {
  return row.evaluate((element) => {
    const text = element.querySelector('input, textarea, [data-truncate="true"]')!;
    const css = getComputedStyle(text);
    const box = text.getBoundingClientRect();
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;top:0;left:0";
    const clone = text instanceof HTMLTextAreaElement ? document.createElement("span") : text.cloneNode(true) as HTMLElement;
    if (text instanceof HTMLTextAreaElement) clone.textContent = "Hg 직접 입력";
    for (const property of css) clone.style.setProperty(property, css.getPropertyValue(property));
    clone.style.display = "inline-block";
    clone.style.verticalAlign = "baseline";
    if (!(clone instanceof HTMLInputElement)) clone.style.overflow = "visible";
    clone.style.width = `${box.width}px`;
    if (text instanceof HTMLTextAreaElement) { clone.style.height = css.lineHeight; clone.style.border = "0"; clone.style.padding = "0"; }
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    wrapper.append(clone, marker); document.body.append(wrapper);
    const baseline = box.top + marker.getBoundingClientRect().top - clone.getBoundingClientRect().top;
    wrapper.remove();
    const rect = element.getBoundingClientRect();
    const number = element.querySelector('[data-slot="icon-slot"]')!.getBoundingClientRect();
    return { x: rect.x, width: rect.width, height: rect.height,
      baseline: baseline - rect.y, textX: box.x, numberX: number.x, numberY: number.y - rect.y,
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
  const input = row.locator("textarea");
  await input.waitFor();
  assert.equal(before.height, page.viewportSize()!.width === 375 ? 44 : 32.296875, "one-line row metrics");
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
  await auditGrowth(row, input, before.height, context);
  await input.fill(""); await compare("empty");
  await input.fill("Custom draft");
  await input.press("Shift+Enter");
  assert.equal(await input.inputValue(), "Custom draft\n", "Shift+Enter inserts a newline");
  await input.evaluate((e) => e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  assert.equal(await input.count(), 1, "IME Enter must keep entry open");
  await input.fill(""); await page.keyboard.press("Escape");
  const after = await compare("back-empty");
  console.log(`GEOMETRY ${context}: row=${before.height}->${after.height}px baseline=${before.baseline}->${after.baseline}px; all states Δ≤0.02px`);
}

export async function auditGrowth(row: Locator, input: Locator, height: number, context: string) {
  const before = await row.boundingBox();
  const field = await input.boundingBox();
  const columns = await row.evaluate(e => [...(e.closest('[data-slot="composer-question-panel"]')?.querySelectorAll("[data-question-option]") ?? [])].map(r => r.getBoundingClientRect().x));
  for (const value of ["첫 번째 줄\n두 번째 줄\n세 번째 줄", "First line\nSecond line\nThird line", "긴한국어단어".repeat(80), "longEnglishWord".repeat(80)]) {
    await input.fill(value);
    assert.equal(await input.inputValue(), value, "complete draft retained");
    const metrics = await input.evaluate((e) => {
      const css = getComputedStyle(e), box = e.getBoundingClientRect();
      const row = e.closest("[data-question-option]")?.getBoundingClientRect();
      return { height: box.height, line: parseFloat(css.lineHeight), reserved: parseFloat(css.getPropertyValue("--focus-ring-width")),
        max: Number(css.getPropertyValue("--textarea-max-lines")), x: box.x, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth,
        top: box.top, numberTop: e.closest("[data-question-option]")?.querySelector('[data-slot="icon-slot"]')?.getBoundingClientRect().top,
        scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, rowHeight: row?.height };
    });
    const lines = (metrics.height - metrics.reserved) / metrics.line;
    assert(Math.abs(lines - Math.round(lines)) < 0.01 && lines > 1 && lines <= metrics.max, `${context}: whole lines ${JSON.stringify(metrics)}`);
    assert(metrics.scrollWidth <= metrics.clientWidth, "no horizontal scroll");
    assert.equal((await input.boundingBox())!.x, field!.x, "stable text column");
    if (metrics.numberTop !== undefined) assert.equal(metrics.numberTop, metrics.top, "number stays on first line");
    assert.deepEqual(await row.evaluate(e => [...(e.closest('[data-slot="composer-question-panel"]')?.querySelectorAll("[data-question-option]") ?? [])].map(r => r.getBoundingClientRect().x)), columns, "other columns stay fixed");
    if (value.startsWith("첫")) await row.screenshot({ path: `/tmp/question-wrap-${context.replaceAll(" ", "-")}.png` });
    if (before && metrics.rowHeight) assert(Math.abs(metrics.rowHeight - Math.max(height, metrics.height - metrics.reserved + 12)) < 0.02, "row follows line height");
    if (Math.round(lines) === metrics.max) {
      assert(metrics.scrollHeight > metrics.clientHeight, "cap scrolls vertically");
      for (const end of [false, true]) {
        await input.evaluate((e, end) => { e.scrollTop = end ? e.scrollHeight : 0; }, end);
        await input.evaluate(async (e, end) => {
          for (let frame = 0; frame < 120; frame++) {
            if (e.getAttribute("data-overflowing") === "true" && e.getAttribute("data-at-end") === String(end)
              && (end ? getComputedStyle(e).getPropertyValue("--scroll-fade-end").trim() === "0px" : parseFloat(getComputedStyle(e).getPropertyValue("--scroll-fade-end")) > 0)) return;
            await new Promise(requestAnimationFrame);
          }
          throw new Error("stale textarea scroll fade");
        }, end);
      }
    }
    console.log(`GROWTH ${context}: lines=${lines} field=${metrics.height}px row=${metrics.rowHeight ?? "standalone"} horizontal=0`);
  }
}

/** Placeholder and entered text remain distinguishable in both field variants. */
export async function assertFieldTones(fields: Locator) {
  for (const field of await fields.all()) {
    const tones = await field.evaluate((element) => ({
      value: getComputedStyle(element).color,
      placeholder: getComputedStyle(element, "::placeholder").color,
      opacity: getComputedStyle(element, "::placeholder").opacity,
    }));
    assert.notEqual(tones.placeholder, tones.value, "placeholder must differ from value text");
    assert.equal(tones.opacity, "1", "placeholder uses the muted token at full opacity");
  }
}
