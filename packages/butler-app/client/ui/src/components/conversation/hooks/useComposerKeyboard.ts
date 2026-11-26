import { useCallback } from "react";
import type { ComposerKeyEvent, ComposerSubmit } from "./composerEventTypes";

export type MultilineSendBehavior =
  | "modifier_enter_send_enter_newline"
  | "enter_send_shift_enter_newline"
  | "enter_newline_shift_enter_send";

interface UseComposerKeyboardProps {
  isComposing: boolean;
  sendDisabled?: boolean;
  multilineSendBehavior?: MultilineSendBehavior | string;
  setModelMenuOpen: (open: boolean) => void;
  setAccessMenuOpen: (open: boolean) => void;
  submit: ComposerSubmit;
}

export function shouldSubmitComposerEnter(input: {
  multilineSendBehavior?: MultilineSendBehavior | string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  if (input.metaKey || input.ctrlKey) return true;
  if (input.shiftKey) return false;
  return input.multilineSendBehavior === "enter_send_shift_enter_newline";
}

export function useComposerKeyboard({
  isComposing,
  sendDisabled,
  multilineSendBehavior,
  setModelMenuOpen,
  setAccessMenuOpen,
  submit,
}: UseComposerKeyboardProps) {
  return useCallback(
    (event: ComposerKeyEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        setModelMenuOpen(false);
        setAccessMenuOpen(false);
        return;
      }
      const native = event.nativeEvent ?? event;
      if (event.key !== "Enter" || native.isComposing || native.keyCode === 229 || isComposing)
        return;
      if (
        shouldSubmitComposerEnter({
          multilineSendBehavior,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        })
      ) {
        event.preventDefault();
        if (!sendDisabled) submit(event);
      }
    },
    [
      isComposing,
      sendDisabled,
      multilineSendBehavior,
      submit,
      setModelMenuOpen,
      setAccessMenuOpen,
    ],
  );
}
