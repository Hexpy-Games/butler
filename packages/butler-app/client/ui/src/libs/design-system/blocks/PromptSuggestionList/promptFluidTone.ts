import { useLayoutEffect, useState, type RefObject } from "react";

export type FluidTone = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Tone for a computed `color-scheme`: a single scheme wins, anything else follows the system. */
export function fluidToneFromColorScheme(colorScheme: string, prefersDark: boolean): FluidTone {
  const schemes = colorScheme.trim().split(/\s+/u).filter((part) => part === "light" || part === "dark");
  if (schemes.length === 1) return schemes[0] as FluidTone;
  return prefersDark ? "dark" : "light";
}

function resolveTone(element: Element): FluidTone {
  const prefersDark = typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
  return fluidToneFromColorScheme(getComputedStyle(element).colorScheme, prefersDark);
}

/**
 * The tone of the nearest theme scope (`.theme-dark` / `.theme-light` set
 * `color-scheme`). Re-resolves when an ancestor's class, data-theme or style
 * changes, or the system scheme flips. `explicit` skips the lookup.
 */
export function useThemeScopeTone(ref: RefObject<Element | null>, explicit?: FluidTone): FluidTone {
  const [scoped, setScoped] = useState<FluidTone>("light");

  useLayoutEffect(() => {
    const element = ref.current;
    if (explicit || !element) return undefined;
    const update = () => setScoped(resolveTone(element));
    update();
    const observer = new MutationObserver(update);
    for (let node = element.parentElement; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    }
    const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
    media?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, [explicit, ref]);

  return explicit ?? scoped;
}
