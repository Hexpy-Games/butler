import { useCallback, useEffect, useRef } from "react";
import type {
  FocusEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
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
  const internalPointerActive = useRef(false);
  useEffect(() => setEngaged(false), [activeChatId, setEngaged]);
  useEffect(() => {
    const releaseInternalPointer = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          internalPointerActive.current = false;
        });
      });
    };
    const cancelInternalPointer = () => {
      internalPointerActive.current = false;
    };
    document.addEventListener("pointerup", releaseInternalPointer);
    document.addEventListener("pointercancel", cancelInternalPointer);
    return () => {
      document.removeEventListener("pointerup", releaseInternalPointer);
      document.removeEventListener("pointercancel", cancelInternalPointer);
    };
  }, []);
  useEffect(() => {
    const collapseOutside = (event: PointerEvent) => {
      const container = containerRef.current;
      if (
        !(event.target instanceof Node) ||
        container?.contains(event.target)
      ) {
        return;
      }
      if (container?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      setEngaged(false);
    };
    document.addEventListener("pointerdown", collapseOutside, true);
    return () =>
      document.removeEventListener("pointerdown", collapseOutside, true);
  }, [containerRef, setEngaged]);

  const onFocusCapture = useCallback(() => setEngaged(true), [setEngaged]);
  const onPointerDownCapture = useCallback(
    (_event: ReactPointerEvent<HTMLFormElement>) => {
      internalPointerActive.current = true;
      setEngaged(true);
    },
    [setEngaged],
  );
  const onBlurCapture = useCallback(
    (event: FocusEvent<HTMLFormElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        !internalPointerActive.current &&
        (!(nextTarget instanceof Node) ||
          !event.currentTarget.contains(nextTarget))
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
    onPointerDownCapture,
  };
}
