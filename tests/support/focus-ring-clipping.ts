// Focus-ring clipping audit for real rendered layout (Playwright).
//
// For the focused element (or its aria-activedescendant), find the element that
// paints the focus indicator (itself or a near ancestor whose outline or
// box-shadow uses the resolved --focus-ring-color), compute the indicator's
// rectangle (outline width + offset, or the outer box-shadow's spread + blur +
// offset; an inset ring stays on the box) and check it against every ancestor
// that clips its painting: overflow (padding box, per axis, honoring
// overflow-clip-margin and the containing-block chain), clip-path (inset() or
// the shape's bounds) and mask (the border box, minus the active edge fades of
// the DS scroll fade, up to where each turns solid). The viewport clips too.
import type { Page } from "playwright";

export type FocusRingClip = {
  /** A readable path to the focused element. */
  target: string;
  label: string;
  ring: { left: number; top: number; right: number; bottom: number };
  /** The ancestor that cuts the ring, and by how many px on each side. */
  clippedBy: string;
  cut: { left: number; top: number; right: number; bottom: number };
};

export type FocusRingProbe = {
  target: string;
  label: string;
  /** No outline or box-shadow in the focus-ring color on the element or a near ancestor. */
  noIndicator?: boolean;
  clips: FocusRingClip[];
};

/** Probes document.activeElement in the page. */
export async function probeFocusRing(page: Page): Promise<FocusRingProbe | null> {
  return page.evaluate(focusRingProbeInPage);
}

/**
 * Runs `act` (a key press that moves focus) and probes the focused ring on
 * each of the next `frames` animation frames from the focus change on, before
 * anything settles: state that lags the focus scroll (a scroller's edge fades)
 * shows there. Each sample runs after the page's own focus handlers' frame work.
 */
export async function probeFocusRingFrames(page: Page, act: () => Promise<void>, frames = 6): Promise<FocusRingClip[]> {
  await page.evaluate(`window.__focusRingProbe = ${focusRingProbeInPage.toString()}`);
  const sampled = page.evaluate((frames) => new Promise<FocusRingClip[]>((resolve) => {
    const probe = (window as unknown as { __focusRingProbe: () => FocusRingProbe | null }).__focusRingProbe;
    const clips: FocusRingClip[] = [];
    let left = frames;
    const sample = () => {
      clips.push(...(probe()?.clips ?? []));
      left -= 1;
      if (left > 0) requestAnimationFrame(sample);
      else resolve(clips);
    };
    const start = () => { clearTimeout(idle); requestAnimationFrame(sample); };
    // A key press that moves focus out of the page fires no focusin.
    const idle = setTimeout(() => { document.removeEventListener("focusin", start); resolve(clips); }, 1000);
    document.addEventListener("focusin", start, { once: true });
  }), frames);
  await act();
  return sampled;
}

// Self-contained: it runs in the page (page.evaluate and the per-frame sampler).
export const focusRingProbeInPage = (): FocusRingProbe | null => {
  type Box = { left: number; top: number; right: number; bottom: number };
  const tolerance = 0.5;
  const describe = (element: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = element; node && parts.length < 5; node = node.parentElement) {
      const slot = node.getAttribute("data-slot");
      const test = node.getAttribute("data-test-class");
      const role = node.getAttribute("role");
      parts.unshift(`${node.tagName.toLowerCase()}${slot ? `[slot=${slot}]` : ""}${test ? `[test=${test.split(" ")[0]}]` : ""}${role ? `[role=${role}]` : ""}`);
    }
    return parts.join(" > ");
  };
  const px = (value: string) => Number.parseFloat(value) || 0;
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (!active || active === document.body || active === document.documentElement) return null;
  const descendant = active.getAttribute("aria-activedescendant");
  const target = (descendant && document.getElementById(descendant)) || active;
  const label = (target.getAttribute("aria-label") || (target as HTMLElement).innerText || target.getAttribute("title") || "")
    .replace(/\s+/gu, " ").trim().slice(0, 60);
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { target: describe(target), label, clips: [] };

  // The ring color as this subtree resolves it (themes scope the token).
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;color:var(--focus-ring-color)";
  target.parentElement?.appendChild(probe);
  const ringColor = getComputedStyle(probe).color;
  probe.remove();
  const sameColor = (value: string) => value.replace(/\s+/gu, "").includes(ringColor.replace(/\s+/gu, ""));

  const outerReach = (element: Element): number | null => {
    const style = getComputedStyle(element);
    let reach: number | null = null;
    if (style.outlineStyle !== "none" && px(style.outlineWidth) > 0 && sameColor(style.outlineColor)) {
      reach = px(style.outlineWidth) + px(style.outlineOffset);
    }
    if (style.boxShadow && style.boxShadow !== "none") {
      for (const shadow of style.boxShadow.split(/,(?![^(]*\))/u)) {
        if (!sameColor(shadow)) continue;
        if (/\binset\b/u.test(shadow)) { reach = Math.max(reach ?? 0, 0); continue; }
        const lengths = shadow.replace(/rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)/gu, "").match(/-?\d+(?:\.\d+)?px/gu) ?? [];
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths.map(px);
        reach = Math.max(reach ?? 0, spread + blur + Math.max(Math.abs(x), Math.abs(y)));
      }
    }
    return reach;
  };

  // The indicator: the target, else the nearest of a few ancestors (a field box around its input).
  let painter: Element | null = null;
  let reach = 0;
  for (let node: Element | null = target, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
    const found = outerReach(node);
    if (found !== null) { painter = node; reach = found; break; }
  }
  if (!painter) return { target: describe(target), label, noIndicator: true, clips: [] };
  const box = painter.getBoundingClientRect();
  const ring: Box = { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach };

  const clips: { target: string; label: string; ring: Box; clippedBy: string; cut: Box }[] = [];
  const check = (visible: Box, by: string) => {
    const cut = {
      left: Math.max(0, visible.left - ring.left),
      top: Math.max(0, visible.top - ring.top),
      right: Math.max(0, ring.right - visible.right),
      bottom: Math.max(0, ring.bottom - visible.bottom),
    };
    if (Object.values(cut).some((value) => value > tolerance)) {
      clips.push({ target: describe(target), label, ring, clippedBy: by, cut });
    }
  };
  const infinite = 1e9;
  const createsContainingBlock = (style: CSSStyleDeclaration, fixed: boolean) =>
    (!fixed && style.position !== "static")
    || style.transform !== "none" || style.translate !== "none" || style.scale !== "none" || style.rotate !== "none"
    || style.filter !== "none" || style.perspective !== "none" || /paint|layout|strict|content/u.test(style.contain)
    || (style.backdropFilter ?? "none") !== "none" || style.willChange.includes("transform");

  let position = getComputedStyle(painter).position;
  for (let node = painter.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    const name = describe(node);
    // overflow clips only descendants whose containing-block chain passes through it.
    const containing = position === "absolute" ? createsContainingBlock(style, false)
      : position === "fixed" ? createsContainingBlock(style, true) : true;
    if (containing) {
      const x = style.overflowX !== "visible";
      const y = style.overflowY !== "visible";
      if (x || y) {
        const margin = style.overflowX === "clip" || style.overflowY === "clip" ? px(style.overflowClipMargin) : 0;
        const left = bounds.left + node.clientLeft;
        const top = bounds.top + node.clientTop;
        check({
          left: x ? left - margin : -infinite,
          top: y ? top - margin : -infinite,
          right: x ? left + node.clientWidth + margin : infinite,
          bottom: y ? top + node.clientHeight + margin : infinite,
        }, `${name} (overflow ${style.overflowX} ${style.overflowY})`);
      }
      position = style.position === "static" || style.position === "relative" || style.position === "sticky" ? position : style.position;
    }
    if (style.clipPath && style.clipPath !== "none") {
      const inset = /^inset\(([^)]*?)(?:\s+round\s[^)]*)?\)/u.exec(style.clipPath);
      if (inset) {
        const values = inset[1].trim().split(/\s+(?![^(]*\))/u).map((value) => {
          const percent = /^(-?[\d.]+)%$/u.exec(value);
          return { value: px(value), percent: percent ? Number(percent[1]) : null };
        });
        const [t, r = t, b = t, l = r] = values;
        const resolve = (side: { value: number; percent: number | null }, size: number) =>
          side.percent === null ? side.value : (side.percent / 100) * size;
        check({
          left: bounds.left + resolve(l, bounds.width),
          top: bounds.top + resolve(t, bounds.height),
          right: bounds.right - resolve(r, bounds.width),
          bottom: bounds.bottom - resolve(b, bounds.height),
        }, `${name} (clip-path ${style.clipPath})`);
      } else check(bounds, `${name} (clip-path ${style.clipPath})`);
    }
    const mask = style.maskImage || style.webkitMaskImage;
    if (mask && mask !== "none") {
      const visible = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
      // The DS scroll fade: an active edge fades the content under it.
      const axis = node.getAttribute("data-scroll-fade");
      // Partly transparent counts as cut: the content is solid only past this.
      const solid = (edge: string) => style.getPropertyValue(`--scroll-fade-${edge}-solid`) || style.getPropertyValue(`--scroll-fade-${edge}`);
      const start = px(solid("start"));
      const end = px(solid("end"));
      if (axis === "y") { visible.top += start; visible.bottom -= end; }
      if (axis === "x") { visible.left += start; visible.right -= end; }
      check(visible, `${name} (mask${axis ? ` scroll-fade ${axis} ${start}/${end}` : ""})`);
    }
    if (style.position === "fixed" && !containing) break;
  }
  check({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, "viewport");
  return { target: describe(target), label, clips };
};

/**
 * Tabs through the page (or until focus cycles) and probes each stop.
 * Returns every clipped ring and every stop without an indicator.
 */
export async function auditTabOrder(page: Page, options: { maxStops?: number; within?: string } = {}) {
  const maxStops = options.maxStops ?? 160;
  const seen = new Set<string>();
  const clipped: FocusRingClip[] = [];
  const unmarked: string[] = [];
  const visited: string[] = [];
  let stops = 0;
  let repeats = 0;
  for (let index = 0; index < maxStops; index += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(40);
    const key = await page.evaluate((within) => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      if (within && !element.closest(within)) return "outside";
      const path: number[] = [];
      for (let node: Element | null = element; node?.parentElement; node = node.parentElement) {
        path.unshift([...node.parentElement.children].indexOf(node));
      }
      return path.join(".");
    }, options.within ?? null);
    if (key === null || key === "outside") continue;
    if (seen.has(key)) { repeats += 1; if (repeats > 2) break; continue; }
    seen.add(key);
    stops += 1;
    // Focus may scroll a container; let its edge fades settle.
    await page.waitForTimeout(60);
    // A ring that fades in (a box-shadow transition) is probed once drawn, not mid-transition.
    await page.evaluate(() => Promise.all((document.activeElement?.getAnimations() ?? [])
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))));
    const probe = await probeFocusRing(page);
    if (!probe) continue;
    visited.push(probe.label || probe.target.split(" > ").at(-1)!);
    if (probe.noIndicator) unmarked.push(`${probe.target} "${probe.label}"`);
    clipped.push(...probe.clips);
  }
  return { stops, clipped, unmarked, visited };
}

export function formatClips(clips: FocusRingClip[]): string {
  const byTarget = new Map<string, FocusRingClip[]>();
  for (const clip of clips) byTarget.set(`"${clip.label}" ${clip.target}`, [...byTarget.get(`"${clip.label}" ${clip.target}`) ?? [], clip]);
  return [...byTarget].map(([target, list]) => `- ${target}\n${list.map((clip) => {
    const sides = Object.entries(clip.cut).filter(([, value]) => value > 0.5)
      .map(([side, value]) => `${side} ${value.toFixed(1)}px`).join(", ");
    return `    cut ${sides} by ${clip.clippedBy}`;
  }).join("\n")}`).join("\n");
}
