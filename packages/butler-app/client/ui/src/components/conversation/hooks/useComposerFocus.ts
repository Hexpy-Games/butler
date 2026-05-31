import { useCallback } from "react";
import type { PointerEvent, RefObject } from "react";

interface UseComposerFocusProps {
  textAreaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerFocus({ textAreaRef }: UseComposerFocusProps) {
  return useCallback(
    (event: PointerEvent<HTMLFormElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          "textarea,button,input,a,select,[role='button'],[role='menuitem'],[data-slot='switch']",
        )
      ) {
        return;
      }
      event.preventDefault();
      textAreaRef.current?.focus({ preventScroll: true });
    },
    [textAreaRef],
  );
}
