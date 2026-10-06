/** Visible reading text; input values and secure controls never enter page data. */
export function readingText(scope, elements) {
  const text = [], seen = new Set();
  const roots = [document, ...globalThis.__butlerClosedRoots ?? []];
  for (const element of elements) if (element.shadowRoot) roots.push(element.shadowRoot);
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    const sections = scope === "text" ? [root] : root.querySelectorAll("p,li,td,th,figcaption");
    for (const section of sections) {
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, element = node.parentElement;
      const value = node.textContent?.replace(/\s+/gu, " ").trim();
      if (!value || !element || seen.has(node) || element.closest("script,style,noscript,button,a,input,select,textarea,[role]") || /^h[1-6]$/u.test(element.localName)) continue;
      if (scope !== "text" && !element.closest("p,li,td,th,figcaption")) continue;
      if (element.getBoundingClientRect().top >= innerHeight || rendering(element)) continue;
      if (semantic(element).secure) continue;
      seen.add(node); text.push(value);
    }
    }
  }
  return text.join("\n");
}
