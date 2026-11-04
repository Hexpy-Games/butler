import { strict as assert } from "node:assert";
import type { Locator } from "playwright";

/**
 * Widths an element draws for `2876x6` and `a->b`, which Pretendard turns into `2876×6` and `a→b` unless ligatures
 * are off. `times`/`arrow` measure the element's own text (one line box each). The rest measure shallow clones of
 * the element (same classes and data attributes): `*Plain` with ligatures off, one glyph per character; `*Font` with
 * them forced on, which proves the font in use substitutes at all.
 */
export interface ExactGlyphs {
  times: number; timesPlain: number; timesFont: number;
  arrow: number; arrowPlain: number; arrowFont: number;
  ligatures: string;
}

export async function measureExactGlyphs(element: Locator): Promise<ExactGlyphs> {
  return element.evaluate((node) => {
    const real = (token: string) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = text.textContent!.indexOf(token);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at); range.setEnd(text, at + token.length);
        const rects = range.getClientRects();
        return rects.length === 1 ? rects[0]!.width : -rects.length;
      }
      return Number.NaN;
    };
    const clone = (text: string, ligatures: "none" | "normal") => {
      const probe = node.cloneNode(false) as HTMLElement;
      probe.removeAttribute("id"); probe.textContent = text;
      Object.assign(probe.style, { position: "absolute", width: "max-content", whiteSpace: "pre", visibility: "hidden", fontVariantLigatures: ligatures });
      node.parentElement!.append(probe);
      const width = probe.getBoundingClientRect().width; probe.remove();
      return width;
    };
    return {
      times: real("2876x6"), timesPlain: clone("2876x6", "none"), timesFont: clone("2876x6", "normal"),
      arrow: real("a->b"), arrowPlain: clone("a->b", "none"), arrowFont: clone("a->b", "normal"),
      ligatures: getComputedStyle(node).fontVariantLigatures,
    };
  });
}

/** Whether the element draws the font's `×` and arrow for `2876x6` and `a->b`; both tokens must agree. */
export async function drawsSubstitutes(element: Locator, label: string): Promise<{ substituted: boolean; width: ExactGlyphs }> {
  const width = await measureExactGlyphs(element);
  const detail = JSON.stringify(width);
  assert(width.times > 0 && width.arrow > 0, `${label}: each token sits on one line: ${detail}`);
  const differs = (a: number, b: number) => Math.abs(a - b) > 0.5;
  assert(differs(width.timesFont, width.timesPlain) && differs(width.arrowFont, width.arrowPlain), `${label}: the font in use substitutes: ${detail}`);
  const times = differs(width.times, width.timesPlain), arrow = differs(width.arrow, width.arrowPlain);
  assert.equal(times, arrow, `${label}: both substitutions agree: ${detail}`);
  return { substituted: times, width };
}
