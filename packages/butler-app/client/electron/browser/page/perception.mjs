export function styleOf(element) {
  const cache = globalThis.__butlerPerceptionCache;
  if (!cache) return getComputedStyle(element);
  if (!cache.styles.has(element)) {
    const style = getComputedStyle(element);
    // CSSStyleDeclaration getters cross into Blink even when the object is cached.
    // Snapshot each used property once, including shared ancestors.
    cache.styles.set(element, { cursor: style.cursor, opacity: style.opacity, display: style.display,
      visibility: style.visibility, clip: style.clip, clipPath: style.clipPath, overflowX: style.overflowX,
      overflowY: style.overflowY, fontSize: style.fontSize, color: style.color, backgroundColor: style.backgroundColor,
      position: style.position, zIndex: style.zIndex });
  }
  return cache.styles.get(element);
}
export function boxOf(element) {
  const cache = globalThis.__butlerPerceptionCache;
  if (!cache) return element.getBoundingClientRect();
  if (!cache.boxes.has(element)) cache.boxes.set(element,element.getBoundingClientRect());
  return cache.boxes.get(element);
}
// Functions are serialized into a Butler-owned isolated world, shared by the L1 provider.
export function parentElementOf(element) {
  return element.parentElement ?? element.getRootNode()?.host ?? null;
}
export function rectangle(element) {
  const box = boxOf(element);
  let left = Math.max(0, box.left), top = Math.max(0, box.top);
  let right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
  for (let parent = parentElementOf(element); parent; parent = parentElementOf(parent)) {
    const style = styleOf(parent), bounds = boxOf(parent);
    if (/(hidden|clip|scroll|auto)/u.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/(hidden|clip|scroll|auto)/u.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
export function rendering(element) {
  let opacity = 1;
  for (let parent = element; parent; parent = parentElementOf(parent)) {
    const style = styleOf(parent);
    opacity *= Number(style.opacity);
    if (style.display === "none" || style.visibility !== "visible" || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true") return "invisible";
    if (style.clip !== "auto" && /rect\(0px, 0px, 0px, 0px\)/u.test(style.clip)) return "invisible";
    if (style.clipPath === "inset(100%)" || style.clipPath === "circle(0px)") return "invisible";
  }
  if (opacity < 0.1) return "invisible";
  const box = rectangle(element);
  if (box.width < 4 || box.height < 4) return "tiny";
  const style = styleOf(element);
  if (parseFloat(style.fontSize) < 6 && element.textContent?.trim()) return "tiny";
  if (contrast(element) < 1.5 && element.textContent?.trim()) return "low_contrast";
  return null;
}
export function contrast(element) {
  const rgb = value => value.match(/[\d.]+/gu)?.map(Number) ?? [];
  const fg = rgb(styleOf(element).color);
  let bg = [];
  for (let parent = element; parent; parent = parentElementOf(parent)) {
    bg = rgb(styleOf(parent).backgroundColor);
    if (bg.length >= 3 && (bg[3] ?? 1) > 0.9) break;
  }
  if (bg.length < 3 || (bg[3] ?? 1) < 0.9) bg = [255, 255, 255];
  const luminance = values => values.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function semantic(element, discoverPointer = true) {
  const tag = element.localName, type = element.getAttribute("type");
  const role = element.getAttribute("role") ?? ({ button: "button", a: "link", select: "combobox", textarea: "textbox", canvas: "canvas", summary: "button" }[tag])
    ?? (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", submit: "button", button: "button" }[type] ?? "textbox") : "");
  const clickable = Boolean(role || element.hasAttribute("onclick") || discoverPointer && styleOf(element).cursor === "pointer" || element.isContentEditable);
  if (!clickable && !/^h[1-6]$/u.test(tag)) return { clickable: false };
  const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u).map(id => element.getRootNode().getElementById?.(id)?.textContent ?? "").join(" ");
  const secure = /recaptcha|hcaptcha|captcha|transkey|nxkey|nprotect|anysign|wizvera/iu.test(location.href) || /one-time-code/u.test(element.autocomplete ?? "") || type === "password" || /cc-number|cc-csc|cc-exp/u.test(element.autocomplete ?? "") || /card.?number|cvc|cvv|transkey|nxkey|nprotect|anysign|wizvera/iu.test(`${element.id} ${element.className} ${element.getAttribute("name") ?? ""}`);
  let name = element.getAttribute("aria-label") || labelled.trim() || element.labels?.[0]?.textContent || element.getAttribute("alt") || element.getAttribute("title") || element.textContent?.trim() || element.getAttribute("placeholder") || "";
  if (!name) { const b = rectangle(element); name = `icon ${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`; }
  const parent = parentElementOf(element);
  const ad = /^(ads?[.-]|.*\.doubleclick\.)/iu.test(location.hostname) || /^(광고|AD|Sponsored|스폰서)(?:\s|$)/iu.test(parent?.getAttribute("aria-label") ?? "") || /^(AD|광고)\b/u.test(parent?.childNodes?.[0]?.textContent?.trim() ?? "") || element.rel?.split(" ").includes("sponsored");
  return { role: role || "button", name: name.replace(/\s+/gu, " "), secure, ad: Boolean(ad), clickable, checked: Boolean(element.checked), preselected: Boolean(element.defaultChecked) };
}
export function hitAt(root, x, y) {
  let hit = root.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(x, y); if (!deeper || deeper === hit) break; hit = deeper; }
  return hit;
}
export function visiblePoint(element) {
  const b = rectangle(element), root = element.getRootNode();
  const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
  let blocker = null;
  for (const [dx, dy] of points) {
    const x = b.x + b.width * dx, y = b.y + b.height * dy;
    const hit = hitAt(root.elementFromPoint ? root : document, x, y);
    if (hit === element || element.contains(hit)) return { x, y, blocker: null };
    if (hit) {
      let coverer = hit;
      for (let parent = hit; parent; parent = parentElementOf(parent)) {
        const style = styleOf(parent);
        if (style.position === "fixed" && Number(style.zIndex) > 0) coverer = parent;
      }
      blocker ??= coverer;
    }
  }
  return { blocker };
}
