import type { Ref, RefCallback } from "react";
import { useComposedRefs } from "./composeRefs";

export const POPPER_EXIT_FROZEN_ATTRIBUTE = "data-exit-frozen";
export const POPPER_EXIT_TRANSFORM_VAR = "--popper-exit-transform";
export const POPPER_EXIT_ORIGIN_VAR = "--popper-exit-origin";
const POPPER_ORIGIN_VAR = "--radix-popper-transform-origin";

/**
 * Radix keeps its floating-ui position loop running while an overlay plays its
 * exit animation. When the anchor unmounts in that window (the composer folds
 * into its compact preview, a row re-renders), the reference rect collapses to
 * 0,0 and the closing overlay slides to the viewport's top-left. Pinning the
 * wrapper's last anchored transform and transform-origin keeps the exit origin-aware: it shrinks
 * and fades toward its anchor. See overlay-exit.css for the override.
 */
export function freezePopperOnExit(content: HTMLElement | null): (() => void) | void {
  if (!content || typeof MutationObserver === "undefined") return;
  const sync = () => {
    const wrapper = content.parentElement;
    if (!wrapper?.hasAttribute("data-radix-popper-content-wrapper")) return;
    if (content.getAttribute("data-state") === "closed") {
      if (wrapper.hasAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE)) return;
      wrapper.style.setProperty(POPPER_EXIT_TRANSFORM_VAR, wrapper.style.transform || "none");
      wrapper.style.setProperty(POPPER_EXIT_ORIGIN_VAR, wrapper.style.getPropertyValue(POPPER_ORIGIN_VAR).trim() || "center");
      wrapper.setAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE, "");
      return;
    }
    wrapper.removeAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE);
    wrapper.style.removeProperty(POPPER_EXIT_TRANSFORM_VAR);
    wrapper.style.removeProperty(POPPER_EXIT_ORIGIN_VAR);
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(content, { attributes: true, attributeFilter: ["data-state"] });
  return () => observer.disconnect();
}

/** Content ref for Radix popper overlays: forwards the caller's ref and freezes exit position. */
export function usePopperExitFreezeRef<T extends HTMLElement>(forwarded?: Ref<T>): RefCallback<T> {
  return useComposedRefs<T>(forwarded, freezePopperOnExit as RefCallback<T>);
}
