/** The document as flat rows for a DevTools read: tags, attributes and text.
 * Never reads a field's live value; what it walks is masked again in Rust. */
export function devtoolsDom({ selector }) {
  // Within the size a host reply may have, measured as JSON: text can grow sixfold there.
  const MAX_NODES = 2500, MAX_BYTES = 200 * 1024, MAX_TEXT = 500, MAX_ATTRIBUTE = 300;
  const encoder = new TextEncoder();
  const short = value => value.length > MAX_ATTRIBUTE ? `${value.slice(0, MAX_ATTRIBUTE)}…[+${value.length - MAX_ATTRIBUTE} chars]` : value;
  const OPAQUE = new Set(["script", "style", "textarea", "noscript", "template"]);
  let root = document.documentElement;
  if (typeof selector === "string" && selector) {
    try { root = document.querySelector(selector); } catch { return { invalid_selector: true }; }
    if (!root) return { selector_matched: false, nodes: [], walked_all: true, total_elements: 0, href: location.href };
  }
  const nodes = [], stack = [[root, 0]];
  let walked = true, bytes = 0;
  const add = row => { nodes.push(row); bytes += encoder.encode(JSON.stringify(row)).length; };
  while (stack.length) {
    if (nodes.length >= MAX_NODES || bytes >= MAX_BYTES) { walked = false; break; }
    const [node, depth] = stack.pop();
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.data.replace(/\s+/gu, " ").trim();
      if (text) add({ d: depth, x: text.slice(0, MAX_TEXT), n: Math.max(0, text.length - MAX_TEXT) });
      continue;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      add({ d: depth, t: "#shadow-root", a: [] });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.localName;
      const row = { d: depth, t: tag, a: [...node.attributes].slice(0, 40).map(item => [item.name.slice(0, 100), short(item.value)]) };
      if (OPAQUE.has(tag)) { row.hidden_chars = node.textContent.length; add(row); continue; }
      add(row);
    } else continue;
    const children = [...node.childNodes];
    if (node.shadowRoot) children.unshift(node.shadowRoot);
    for (const child of children.reverse()) stack.push([child, depth + 1]);
  }
  return { selector_matched: true, nodes, walked_all: walked, total_elements: root.querySelectorAll("*").length + 1, href: location.href };
}
