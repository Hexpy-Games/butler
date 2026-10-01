import { useCallback } from "react";
import type { PointerEvent, RefObject } from "react";
import { focusComposer } from "../editor/focusComposer";

interface UseComposerFocusProps {
  textAreaRef: RefObject<HTMLElement | null>;
}

export function useComposerFocus({ textAreaRef }: UseComposerFocusProps) {
  return useCallback(
    (event: PointerEvent<HTMLFormElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          "[contenteditable='true'],textarea,button,input,a,select,[role='button'],[role='menuitem'],[data-slot='switch']",
        )
      ) {
        return;
      }
      event.preventDefault();
      focusComposer(textAreaRef.current, "restore");
    },
    [textAreaRef],
  );
}
