/** Run in the renderer: border boxes can be cut even when scrollWidth fits. */
export function visibleClipping() {
  const selector = (node: Element): string => {
    if (node.id) return `#${CSS.escape(node.id)}`;
    for (const name of ["data-test-class", "data-slot"]) {
      const value = node.getAttribute(name);
      if (value && document.querySelectorAll(`[${name}=${JSON.stringify(value)}]`).length === 1) return `[${name}=${JSON.stringify(value)}]`;
    }
    const parent = node.parentElement;
    return parent ? `${selector(parent)} > ${node.localName}:nth-child(${[...parent.children].indexOf(node) + 1})` : node.localName;
  };
  const findings: Array<{ selector: string; ancestor: string; side: string; px: number }> = [];
  const clips = (value: string) => ["hidden", "clip", "auto", "scroll"].includes(value);
  for (const node of document.querySelectorAll<HTMLElement>("*")) {
    if (node.closest('[hidden],[inert],[aria-hidden="true"]') || !node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    let visuallyHidden = false;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1 && (css.clip !== "auto" || css.clipPath !== "none")) visuallyHidden = true;
    }
    if (visuallyHidden) continue;
    const ownText = [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
    if (!ownText && !node.matches('img,svg,canvas,[role="img"]')) continue;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (style.visibility !== "visible" || (rect.width <= 1 && rect.height <= 1 && (style.clip !== "auto" || style.clipPath !== "none"))) continue;
    if ((style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap") || Number(style.webkitLineClamp) > 0) continue;
    const bounds: Array<{ node: Element | null; left: number; right: number; top: number; bottom: number; x: boolean; y: boolean; scrollX: boolean; scrollY: boolean }> = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (!clips(css.overflowX) && !clips(css.overflowY)) continue;
      const sx = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
      const sy = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
      bounds.push({ node: parent, left: box.left + parent.clientLeft * sx, right: box.left + (parent.clientLeft + parent.clientWidth) * sx,
        top: box.top + parent.clientTop * sy, bottom: box.top + (parent.clientTop + parent.clientHeight) * sy,
        x: clips(css.overflowX), y: clips(css.overflowY), scrollX: ["auto", "scroll"].includes(css.overflowX) && parent.scrollWidth > parent.clientWidth,
        scrollY: ["auto", "scroll"].includes(css.overflowY) && parent.scrollHeight > parent.clientHeight });
    }
    bounds.push({ node: null, left: 0, right: innerWidth, top: 0, bottom: innerHeight, x: true, y: true, scrollX: false, scrollY: false });
    let top = rect.top, bottom = rect.bottom, left = rect.left, right = rect.right;
    for (const box of bounds) {
      const css = box.node && getComputedStyle(box.node);
      // Inline descendants paint inside their ancestor's intentional ellipsis.
      // Only its inline-axis cut is disclosed; vertical clipping still fails.
      if (css && css.textOverflow === "ellipsis" && css.whiteSpace === "nowrap" && box.x) {
        left = Math.max(left, box.left); right = Math.min(right, box.right);
      }
      const cuts = { left: box.x ? box.left - left : 0, right: box.x ? right - box.right : 0,
        top: box.y ? box.top - top : 0, bottom: box.y ? bottom - box.bottom : 0 };
      // A scrolling axis exposes only its visible slice to outer ancestors.
      // The other axis still reports cuts, including a scroller's hidden axis.
      for (const [side, px] of Object.entries(cuts)) {
        const reachable = side === "left" || side === "right" ? box.scrollX : box.scrollY;
        if (px <= 1 || reachable) continue;
        findings.push({ selector: selector(node), ancestor: box.node ? selector(box.node) : "viewport", side, px: Math.round(px * 100) / 100 });
      }
      if (box.scrollX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (box.scrollY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      if (right <= left || bottom <= top) break;
    }
  }
  return findings;
}
