import { useEffect, useRef, type RefObject } from "react";
import { focusComposer } from "@/components/conversation/editor/focusComposer";

/** Returning from the palette is programmatic composer focus, at the draft end. */
export function useCommandPaletteFocus(open: boolean, inputRef: RefObject<HTMLInputElement | null>, resetQuery: () => void) {
  const returnComposer = useRef<HTMLElement | null>(null);
  const reset = useRef(resetQuery);
  reset.current = resetQuery;
  useEffect(() => {
    if (!open) {
      const editor = returnComposer.current;
      returnComposer.current = null;
      if (!editor) return;
      const frame = requestAnimationFrame(() => { if (editor.isConnected) focusComposer(editor); });
      return () => cancelAnimationFrame(frame);
    }
    const active = document.activeElement;
    returnComposer.current = active instanceof HTMLElement && active.isContentEditable ? active : null;
    reset.current();
    inputRef.current?.focus();
  }, [open, inputRef]);
}
