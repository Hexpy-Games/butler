// Forced interaction states for the DS Viewer states matrix. A cell marked
// `data-ds-force-state="hover"` renders as if its target were hovered: the
// viewer copies every loaded rule that uses :hover, :focus(-visible|-within)
// or :active into a small stylesheet where the pseudo-class is replaced by the
// attribute. The target is the one element marked `data-ds-force-target` (the
// first enabled focusable element unless a story marks its own), so a cell
// with several segments paints only the intended one. Like real :hover, the
// target's ancestors match too. The product CSS stays untouched and the layer
// only exists while a matrix shows.

const TARGET = "[data-ds-force-target]";

/** Elements the matrix may mark as the forced target, in document order. */
export const FORCE_TARGET_CANDIDATES = [
  "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)", "textarea:not(:disabled)", "a[href]",
  "[role=\"button\"]", "[role=\"switch\"]", "[role=\"tab\"]", "[role=\"radio\"]", "[role=\"slider\"]",
  "[role=\"option\"]", "[role=\"menuitem\"]", "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

/** The target and its ancestors inside a cell forced into `state` (how :hover matches). */
function targetOrAncestor(state: string): string {
  return `:is([data-ds-force-state~="${state}"] :is(${TARGET}, :has(${TARGET})))`;
}

const FOCUSED = `:is([data-ds-force-state~="focus-visible"] ${TARGET})`;

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/:hover(?![\w-])/gu, targetOrAncestor("hover")],
  [/:active(?![\w-])/gu, targetOrAncestor("active")],
  [/:focus-visible(?![\w-])/gu, FOCUSED],
  [/:focus-within(?![\w-])/gu, targetOrAncestor("focus-visible")],
  [/:focus(?![\w-])/gu, FOCUSED],
];

/** Marks the forced target in every states-matrix cell under `root` that has none yet. */
export function markForceTargets(root: ParentNode): void {
  for (const cell of Array.from(root.querySelectorAll("[data-ds-force-state]"))) {
    if (cell.querySelector(TARGET)) continue;
    cell.querySelector(FORCE_TARGET_CANDIDATES)?.setAttribute("data-ds-force-target", "");
  }
}

/** The selector with interaction pseudo-classes replaced, or null when it has none. */
export function forceStateSelector(selector: string): string | null {
  let result = selector;
  for (const [pattern, replacement] of REPLACEMENTS) result = result.replace(pattern, replacement);
  return result === selector ? null : result;
}

export type ForceStateRule =
  | { kind: "style"; selector: string; declarations: string; children?: ForceStateRule[] }
  | { kind: "group"; prelude: string; rules: ForceStateRule[] };

function emit(rule: ForceStateRule): string {
  if (rule.kind === "group") {
    const inner = rule.rules.map(emit).filter(Boolean).join(" ");
    return inner ? `${rule.prelude} { ${inner} }` : "";
  }
  const rewritten = forceStateSelector(rule.selector);
  const nested = (rule.children ?? []).map(emit).filter(Boolean).join(" ");
  if (rewritten) return `${rewritten} { ${rule.declarations}${nested ? ` ${nested}` : ""} }`;
  // Nested rules (CSS nesting) keep their parent selector as the context.
  return nested ? `${rule.selector} { ${nested} }` : "";
}

export function forceStateCss(rules: ForceStateRule[]): string {
  return rules.map(emit).filter(Boolean).join("\n");
}

function readRules(list: CSSRuleList): ForceStateRule[] {
  const rules: ForceStateRule[] = [];
  for (const rule of Array.from(list)) {
    if (rule instanceof CSSStyleRule) {
      const children = rule.cssRules?.length ? readRules(rule.cssRules) : undefined;
      rules.push({ kind: "style", selector: rule.selectorText, declarations: rule.style.cssText, children });
    } else if (rule instanceof CSSGroupingRule) {
      const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
      rules.push({ kind: "group", prelude, rules: readRules(rule.cssRules) });
    }
  }
  return rules;
}

/** Reads the document's stylesheets (same-origin only) into rules. */
export function documentRules(doc: Document): ForceStateRule[] {
  return Array.from(doc.styleSheets).flatMap((sheet) => {
    try {
      return readRules(sheet.cssRules);
    } catch {
      return [];
    }
  });
}
