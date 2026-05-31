import { useCallback } from "react";
import type { KeyboardEvent } from "react";
import type { ComposerSubmit } from "./composerEventTypes";

export type MultilineSendBehavior =
  | "modifier_enter_send_enter_newline"
  | "enter_send_shift_enter_newline"
  | "enter_newline_shift_enter_send";

interface UseComposerKeyboardProps {
  isComposing: boolean;
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
  multilineSendBehavior,
  setModelMenuOpen,
  setAccessMenuOpen,
  submit,
}: UseComposerKeyboardProps) {
  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        setModelMenuOpen(false);
        setAccessMenuOpen(false);
        return;
      }
      if (event.key !== "Enter" || event.nativeEvent.isComposing || isComposing)
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
        submit(event);
      }
    },
    [
      isComposing,
      multilineSendBehavior,
      submit,
      setModelMenuOpen,
      setAccessMenuOpen,
    ],
  );
}
