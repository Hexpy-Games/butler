import type { CoastalScene } from "./coastalScene";

/** Event-driven invalidation; static scenes redraw only on visibility/size/context changes. */
export function decorationVisibility(root: HTMLElement, coast: CoastalScene | undefined, update: (visible: boolean) => void) {
  let intersecting = false;
  const refresh = () => update(intersecting && !document.hidden);
  const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; refresh(); });
  observer.observe(root);
  const resize = new ResizeObserver(([entry]) => {
    coast?.resize(entry.contentRect.width, entry.contentRect.height);
    refresh();
  });
  resize.observe(root);
  const canvas = root.querySelector("canvas");
  canvas?.addEventListener("webglcontextlost", refresh);
  canvas?.addEventListener("webglcontextrestored", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    observer.disconnect(); resize.disconnect();
    canvas?.removeEventListener("webglcontextlost", refresh);
    canvas?.removeEventListener("webglcontextrestored", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}
