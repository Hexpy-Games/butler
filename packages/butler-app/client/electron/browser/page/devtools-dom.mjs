/** The document as flat rows for a DevTools read: tags, attributes and text.
 * Never reads a field's live value; what it walks is masked again in Rust. */
export function devtoolsDom({ selector }) {
  // Within the size a host reply may have, whatever the page's alphabet.
  const MAX_NODES = 2500, MAX_CHARS = 45000, MAX_TEXT = 500, MAX_ATTRIBUTE = 300;
  const short = value => value.length > MAX_ATTRIBUTE ? `${value.slice(0, MAX_ATTRIBUTE)}…[+${value.length - MAX_ATTRIBUTE} chars]` : value;
  const OPAQUE = new Set(["script", "style", "textarea", "noscript", "template"]);
  let root = document.documentElement;
  if (typeof selector === "string" && selector) {
    try { root = document.querySelector(selector); } catch { return { invalid_selector: true }; }
    if (!root) return { selector_matched: false, nodes: [], walked_all: true, total_elements: 0 };
  }
  const nodes = [], stack = [[root, 0]];
  let walked = true, chars = 0;
  while (stack.length) {
    if (nodes.length >= MAX_NODES || chars >= MAX_CHARS) { walked = false; break; }
    const [node, depth] = stack.pop();
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.data.replace(/\s+/gu, " ").trim();
      if (text) { nodes.push({ d: depth, x: text.slice(0, MAX_TEXT), n: Math.max(0, text.length - MAX_TEXT) }); chars += Math.min(text.length, MAX_TEXT); }
      continue;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      nodes.push({ d: depth, t: "#shadow-root", a: [] });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.localName;
      const row = { d: depth, t: tag, a: [...node.attributes].slice(0, 40).map(item => [item.name.slice(0, 100), short(item.value)]) };
      chars += tag.length + row.a.reduce((sum, [name, value]) => sum + name.length + value.length, 0);
      if (OPAQUE.has(tag)) { row.hidden_chars = node.textContent.length; nodes.push(row); continue; }
      nodes.push(row);
    } else continue;
    const children = [...node.childNodes];
    if (node.shadowRoot) children.unshift(node.shadowRoot);
    for (const child of children.reverse()) stack.push([child, depth + 1]);
  }
  return { selector_matched: true, nodes, walked_all: walked, total_elements: root.querySelectorAll("*").length + 1 };
}
