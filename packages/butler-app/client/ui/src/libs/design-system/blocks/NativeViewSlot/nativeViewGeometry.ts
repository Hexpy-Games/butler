/** Where the native view goes: whole CSS pixels in window (viewport) coordinates. */
export interface NativeViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** False while the slot is hidden, unmounted or zero-size: hide the native view. */
  visible: boolean;
  /** Fixed-viewport mode: rendered width / logical width (the page zoom). 1 otherwise. */
  scale: number;
}

/** A fixed logical page size, e.g. an agent tab's 1280×800. */
export interface NativeViewViewport {
  width: number;
  height: number;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Scale of a fixed logical viewport rendered `renderedWidth` px wide (4 decimals). */
export function nativeViewScale(viewport: NativeViewViewport | undefined, renderedWidth: number): number {
  if (!viewport || viewport.width <= 0) return 1;
  return Math.round((renderedWidth / viewport.width) * 10_000) / 10_000;
}

/** Snaps a client rect to whole pixels without growing gaps between neighbors. */
export function toNativeViewBounds(rect: RectLike, visible: boolean, viewport?: NativeViewViewport): NativeViewBounds {
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  const width = Math.max(0, Math.round(rect.right) - x);
  const height = Math.max(0, Math.round(rect.bottom) - y);
  return { x, y, width, height, visible: visible && width > 0 && height > 0, scale: nativeViewScale(viewport, rect.width) };
}

export function sameNativeViewBounds(a: NativeViewBounds, b: NativeViewBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.visible === b.visible && a.scale === b.scale;
}

/** True when two rects share area (touching edges do not count). */
export function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** CSS transition properties that move or resize a box. */
export const GEOMETRY_TRANSITIONS = new Set([
  "all", "transform", "translate", "scale", "rotate", "width", "height", "inset", "left", "right", "top", "bottom",
  "margin", "margin-left", "margin-right", "margin-top", "margin-bottom", "margin-inline", "margin-block",
  "padding", "padding-left", "padding-right", "padding-inline", "flex-basis", "grid-template-columns",
  "grid-template-rows", "max-width", "max-height", "block-size", "inline-size",
]);

/** Keyframe keys (camelCase) that move or resize a box. */
const GEOMETRY_KEYFRAMES = new Set([
  "transform", "translate", "scale", "rotate", "width", "height", "inset", "left", "right", "top", "bottom",
  "marginLeft", "marginRight", "marginTop", "marginBottom", "flexBasis", "gridTemplateColumns", "gridTemplateRows",
  "maxWidth", "maxHeight", "blockSize", "inlineSize",
]);

/** A running transition, CSS animation or WAAPI animation that moves or resizes its element. */
export function animatesGeometry(animation: Animation): boolean {
  if (animation.playState !== "running") return false;
  if ("transitionProperty" in animation) return GEOMETRY_TRANSITIONS.has(String(animation.transitionProperty));
  const effect = animation.effect as KeyframeEffect | null;
  const frames = typeof effect?.getKeyframes === "function" ? effect.getKeyframes() : [];
  return frames.some((frame) => Object.keys(frame).some((key) => GEOMETRY_KEYFRAMES.has(key)));
}

export function hasGeometryAnimation(element: Element): boolean {
  return typeof element.getAnimations === "function" && element.getAnimations().some(animatesGeometry);
}
