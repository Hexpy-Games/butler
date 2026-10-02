import { useEffect, type RefObject } from "react";

/** Keep a deep link aligned while its lazy specimens and fonts settle, until the user takes over. */
export function useInitialAnchor(scroller: RefObject<HTMLElement | null>, anchor: string | undefined) {
  useEffect(() => {
    const root = scroller.current;
    if (!root || !anchor) return undefined;
    let frame = 0;
    let live = true;
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!live) return;
        const target = document.getElementById(anchor);
        if (target && root.contains(target)) {
          root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
        }
      });
    };
    const resized = new ResizeObserver(align);
    if (root.firstElementChild) resized.observe(root.firstElementChild);
    const mounted = new MutationObserver(align);
    mounted.observe(root, { childList: true, subtree: true });
    const stop = () => {
      live = false;
      cancelAnimationFrame(frame);
      resized.disconnect();
      mounted.disconnect();
      document.fonts.removeEventListener("loadingdone", align);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        window.removeEventListener(event, stop, true);
      }
    };
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.addEventListener(event, stop, { capture: true, passive: true });
    }
    document.fonts.addEventListener("loadingdone", align);
    void document.fonts.ready.then(() => live && align());
    align();
    return stop;
  }, [scroller, anchor]);
}
