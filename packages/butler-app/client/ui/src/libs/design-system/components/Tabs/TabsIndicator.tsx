import { useLayoutEffect, useRef } from "react";
import styles from "./Tabs.module.css";

/**
 * Line-tab underline that slides to the active trigger. A 1px bar is placed
 * with translateX and sized with scaleX, so switching tabs only moves a
 * compositor layer (decelerate, --motion-base; reduced motion jumps). The
 * list gets data-indicator-ready once measured, which retires the static
 * active-trigger underline used before hydration.
 */
export function TabsIndicator() {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // The list is the parent: its own ref is not attached yet when this
    // child layout effect runs.
    const indicator = indicatorRef.current;
    const list = indicator?.parentElement;
    if (!list || !indicator) return;
    const place = () => {
      const active = list.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-state="active"]');
      if (!active) {
        indicator.style.opacity = "0";
        return;
      }
      indicator.style.opacity = "";
      const target = active.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      indicator.style.transform = `translateX(${target.left - frame.left + list.scrollLeft}px) scaleX(${target.width})`;
      if (!list.hasAttribute("data-indicator-ready")) {
        // First placement lands without sliding in from the start edge.
        indicator.getBoundingClientRect();
        list.setAttribute("data-indicator-ready", "");
      }
    };
    place();
    const mutations = new MutationObserver(place);
    mutations.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"], childList: true });
    // Resize/locale changes land directly; only tab selection should slide.
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      list.removeAttribute("data-indicator-ready");
      place();
    }) : null;
    resize?.observe(list);
    for (const trigger of list.querySelectorAll('[data-slot="tabs-trigger"]')) resize?.observe(trigger);
    return () => {
      mutations.disconnect();
      resize?.disconnect();
    };
  }, []);
  return <span ref={indicatorRef} aria-hidden="true" className={styles.indicator} data-slot="tabs-indicator" />;
}
