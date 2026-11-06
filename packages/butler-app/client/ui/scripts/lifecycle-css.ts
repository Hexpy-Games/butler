/** Keep DS rules that can style this subtree, including inactive focus/motion states. */
export function captureLifecycleCss(root: Element): string {
  const nodes = [document.documentElement, document.body, root, ...root.querySelectorAll("*")];
  const matches = (selector: string) => {
    const relaxed = selector.replace(/\[data-breathe=[^\]]+\]/g, "").replace(/:(?:hover|active|focus-visible|focus|disabled)/g, "").replace(/::[\w-]+/g, "");
    try { return nodes.some((node) => node.matches(relaxed)); } catch { return false; }
  };
  const tokens: Array<{ selector: string; entries: Array<[string, string]> }> = [];
  const selected: string[] = [];
  const frames: CSSKeyframesRule[] = [];
  const kept: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList): string[] => {
    const result: string[] = [];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (/^:root$|^\.theme-(light|dark)$/.test(rule.selectorText)) {
          tokens.push({ selector: rule.selectorText, entries: Array.from(rule.style).map((name) => [name, rule.style.getPropertyValue(name)]) });
        } else if (matches(rule.selectorText) || /data-motion="reduced"/.test(rule.selectorText) || /:lang\(ko\)/.test(rule.selectorText) || /_(incoming|outgoing)_/.test(rule.selectorText) || rule.selectorText === "[hidden]") result.push(`\uE000${kept.push(rule) - 1}\uE000`);
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) result.push(...walk(rule.styleSheet.cssRules));
      } else if (rule instanceof CSSMediaRule) {
        if (/width/.test(rule.conditionText)) continue;
        const inner = walk(rule.cssRules);
        if (inner.length) result.push(`@media ${rule.conditionText}{${inner.join("")}}`);
      } else if (rule instanceof CSSKeyframesRule) frames.push(rule);
    }
    return result;
  };
  for (const sheet of document.styleSheets) selected.push(...walk(sheet.cssRules));
  const used = new Set<string>();
  const add = (text: string) => { for (const [, key] of text.matchAll(/var\((--[\w-]+)/g)) used.add(key!); };
  // Markers stand for kept rules; their custom properties are pruned once usage is known.
  const withRules = (text: string, render: (rule: CSSStyleRule) => string) => text.replace(/\uE000(\d+)\uE000/g, (_, index) => render(kept[Number(index)]!));
  const included = frames.filter((frame) => withRules(selected.join(""), (rule) => rule.cssText).includes(frame.name)).map((frame) => frame.cssText);
  add(selected.join("") + included.join(""));
  // Custom properties only: a shorthand's longhands read back empty when it holds var(), so usage comes from cssText.
  const declarations = (rule: CSSStyleRule) => Array.from(rule.style).filter((name) => name.startsWith("--")).map((name) => [name, rule.style.getPropertyValue(name)] as [string, string]);
  const without = (rule: CSSStyleRule, drop: (name: string) => boolean) => declarations(rule)
    .filter(([name]) => drop(name)).reduce((text, [name, value]) => text.replace(`${name}: ${value};`, ""), rule.cssText);
  for (const rule of kept) add(without(rule, () => true));
  for (let size = -1; size !== used.size;) {
    size = used.size;
    for (const entries of [...tokens.map((block) => block.entries), ...kept.map(declarations)]) for (const [name, value] of entries) if (used.has(name)) add(value);
  }
  const rendered = withRules(selected.join(""), (rule) => without(rule, (name) => !used.has(name)));
  const pinned = tokens.map(({ selector, entries }) => `${selector}{${entries.filter(([name]) => !name.startsWith("--") || used.has(name)).map(([name, value]) => `${name}:${value};`).join("")}}`);
  return [...pinned, rendered, ...included].join("").replace(/\s+/g, " ").replace(/\s*([{}:;,])\s*/g, "$1").replace(/;}/g, "}");
}
