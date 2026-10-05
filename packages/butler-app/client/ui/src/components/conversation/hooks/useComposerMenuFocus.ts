import { useRef, type FocusEvent, type PointerEvent } from "react";

/** Popover suppresses automatic focus; Esc returns to this row's opener. */
export function useComposerMenuFocus() {
  const opener = useRef<HTMLButtonElement | null>(null);
  const escaped = useRef(false);
  return {
    trigger: {
      onFocus: (event: FocusEvent<HTMLButtonElement>) => { opener.current = event.currentTarget; },
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => { opener.current = event.currentTarget; },
    },
    content: {
      onEscapeKeyDown: () => { escaped.current = true; },
      onCloseAutoFocus: (event: Event) => {
        event.preventDefault();
        if (escaped.current) opener.current?.focus();
        escaped.current = false;
      },
    },
  };
}
