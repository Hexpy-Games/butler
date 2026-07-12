import { useCallback, useEffect } from "react";
import type { FocusEvent, RefObject } from "react";
import { useComposerStore } from "../composerStore";

export function useComposerPresentation({
  activeChatId,
  containerRef,
  protectedExpanded,
}: {
  activeChatId: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  protectedExpanded: boolean;
}) {
  const engaged = useComposerStore((store) => store.engaged);
  const setEngaged = useComposerStore((store) => store.setEngaged);
  useEffect(() => setEngaged(false), [activeChatId, setEngaged]);
  useEffect(() => {
    const collapseOutside = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!(event.target instanceof Node) || container?.contains(event.target)) {
        return;
      }
      if (container?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      setEngaged(false);
    };
    document.addEventListener("pointerdown", collapseOutside, true);
    return () => document.removeEventListener("pointerdown", collapseOutside, true);
  }, [containerRef, setEngaged]);

  const onFocusCapture = useCallback(() => setEngaged(true), [setEngaged]);
  const onBlurCapture = useCallback(
    (event: FocusEvent<HTMLFormElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        !(nextTarget instanceof Node) ||
        !event.currentTarget.contains(nextTarget)
      ) {
        setEngaged(false);
      }
    },
    [setEngaged],
  );

  return {
    expanded: engaged || protectedExpanded,
    onBlurCapture,
    onFocusCapture,
  };
}
