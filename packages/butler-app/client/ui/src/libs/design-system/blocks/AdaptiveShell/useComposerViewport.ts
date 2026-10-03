import { useEffect, type RefObject } from "react";

/** One shell adapter; subtract only occlusion not already handled by layout resizing. */
export function useComposerViewport(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = ref.current;
    const viewport = window.visualViewport;
    if (!root || !viewport || root.parentElement?.closest("[data-chrome-environment]")) return;
    const update = () => {
      const occlusion = viewport.scale === 1
        ? Math.max(0, root.getBoundingClientRect().bottom - viewport.height - viewport.offsetTop) : 0;
      root.style.setProperty("--keyboard-inset-bottom", `${occlusion}px`);
      root.style.setProperty("--composer-safe-bottom", occlusion > 0 ? "0px" : "var(--safe-area-bottom)");
      root.style.setProperty("--composer-available-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      for (const name of ["--keyboard-inset-bottom", "--composer-safe-bottom", "--composer-available-height"]) root.style.removeProperty(name);
    };
  }, [ref]);
}
