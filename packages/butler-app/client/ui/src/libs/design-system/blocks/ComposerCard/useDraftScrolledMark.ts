import { useEffect, useRef } from "react";

/**
 * While `active` (a decorated card), marks the form `data-draft-scrolled` as its
 * editor (an element with `editorClass`) scrolls, from one passive capture
 * `scroll` listener: nothing runs on the typing path. Returns the form's ref.
 */
export function useDraftScrolledMark(active: boolean, editorClass: string) {
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form || !active) return undefined;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains(editorClass)) return;
      const scrolled = target.scrollTop > 0 ? "true" : "false";
      if (form.dataset.draftScrolled !== scrolled) form.dataset.draftScrolled = scrolled;
    };
    form.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      form.removeEventListener("scroll", onScroll, { capture: true });
      delete form.dataset.draftScrolled;
    };
  }, [active, editorClass]);
  return formRef;
}
