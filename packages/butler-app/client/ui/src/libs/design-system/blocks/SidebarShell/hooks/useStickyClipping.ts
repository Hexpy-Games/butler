import { useLayoutEffect, type RefObject } from "react";

/** Paint boundaries only; CSS remains the owner of scrolling and sticky layout. */
export function useStickyClipping(
  contentRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroll = content?.parentElement;
    if (!enabled || !content || !scroll) return;
    let frame = 0;
    let regions: { body: HTMLElement; header: HTMLElement }[] = [];

    const update = () => {
      frame = 0;
      // Read the complete geometry before writing styles (no layout thrashing).
      const measurements = regions.map(({ body, header }) => {
        const rect = body.getBoundingClientRect();
        const top = Math.max(0, Math.min(rect.height,
          header.getBoundingClientRect().bottom - rect.top));
        return { body, value: `${top}px` };
      });
      for (const { body, value } of measurements) {
        if (body.style.getPropertyValue("--sticky-clip-top") !== value) {
          body.style.setProperty("--sticky-clip-top", value);
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    const collect = () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      regions = Array.from(content.querySelectorAll<HTMLElement>("[data-sticky-clip]"))
        .flatMap(body => body.previousElementSibling instanceof HTMLElement
          ? [{ body, header: body.previousElementSibling }] : []);
      resize.observe(scroll);
      for (const { body, header } of regions) {
        resize.observe(body);
        resize.observe(header);
      }
      update();
    };
    const revealFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const target = event.target;
      const scrollTop = scroll.getBoundingClientRect().top;
      let boundary = scrollTop;
      for (const { body, header } of regions) {
        if (!body.contains(target)) continue;
        // Use the pinned position, not a header currently pushed out by its branch end.
        boundary = Math.max(boundary, scrollTop +
          (Number.parseFloat(getComputedStyle(header).top) || 0) +
          header.getBoundingClientRect().height);
      }
      const top = target.getBoundingClientRect().top;
      if (top < boundary) scroll.scrollTop -= boundary - top;
      cancelAnimationFrame(frame);
      update();
    };
    const mutations = new MutationObserver(collect);
    mutations.observe(content, { childList: true, subtree: true,
      attributes: true, attributeFilter: ["data-state"] });
    scroll.addEventListener("scroll", schedule, { passive: true });
    scroll.addEventListener("focusin", revealFocus);
    collect();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroll.removeEventListener("scroll", schedule);
      scroll.removeEventListener("focusin", revealFocus);
      for (const { body } of regions) body.style.removeProperty("--sticky-clip-top");
    };
  }, [contentRef, enabled]);
}
