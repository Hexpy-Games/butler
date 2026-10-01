import type { Page } from "playwright";
import { contrastRatio, flatten, parseColor, type Rgba } from "../../packages/butler-app/client/ui/src/libs/design-system/viewer/foundations/contrast.ts";

/** Let initial theme transitions finish before measuring the painted screen. */
export async function settleFirstRun(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-first-run-screen]');
    return root && root.getAnimations({ subtree: true }).every((animation) =>
      animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== "running");
  });
  await page.evaluate(() => document.fonts.ready);
}

/** Audit every rendered text node, including text below the scroll fold. */
export async function assertFirstRunContrast(page: Page) {
  await settleFirstRun(page);
  const nodes = await page.locator('[data-first-run-screen]').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const result: Array<{ text: string; color: string; backgrounds: string[]; size: number; weight: number; opacity: number }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement!;
      if (!node.textContent?.trim() || element.closest('option, script, style, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNode(node);
      if (!range.getBoundingClientRect().width) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== "visible") continue;
      const backgrounds: string[] = [];
      let opacity = 1;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const paint = getComputedStyle(ancestor);
        opacity *= Number(paint.opacity);
        backgrounds.push(paint.backgroundColor);
        if (ancestor.matches('[data-surface="solid"]')) break;
      }
      if (!opacity) continue;
      result.push({ text: node.textContent.trim(), color: style.color, backgrounds,
        size: parseFloat(style.fontSize), weight: parseInt(style.fontWeight), opacity });
    }
    return result;
  });
  if (!nodes.length) throw new Error("No first-run text audited");
  let minimum = Infinity;
  for (const node of nodes) {
    let background: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    for (const paint of node.backgrounds) {
      const parsed = parseColor(paint);
      if (!parsed) throw new Error(`Unparsed background: ${paint}`);
      background = flatten(background, parsed);
      if (background.a === 1) break;
    }
    if (background.a !== 1) throw new Error(`Text has no opaque surface: ${node.text}`);
    const foreground = parseColor(node.color);
    if (!foreground) throw new Error(`Unparsed foreground: ${node.color}`);
    const ratio = contrastRatio({ ...foreground, a: foreground.a * node.opacity }, background);
    const required = node.size >= 24 || (node.size >= 18.66 && node.weight >= 700) ? 3 : 4.5;
    if (ratio < required) throw new Error(`Contrast ${ratio.toFixed(2)} < ${required}: ${node.text} (${node.color}, ${JSON.stringify(background)}, opacity ${node.opacity})`);
    minimum = Math.min(minimum, ratio);
  }
  return { nodes: nodes.length, minimum };
}

export async function assertFirstRunLayout(page: Page) {
  const card = page.locator('[data-surface="solid"]');
  if (await card.count() !== 1) throw new Error("Expected one solid content card");
  const valid = await card.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(node).paddingInlineStart);
    return [...node.children].every((child) => {
      const box = child.getBoundingClientRect();
      return Math.abs(box.left - bounds.left - inset - 1) < 1 && Math.abs(box.right - bounds.right + inset + 1) < 1;
    }) && document.documentElement.scrollWidth <= innerWidth;
  });
  if (!valid) throw new Error("Content insets differ or page overflows");
}
