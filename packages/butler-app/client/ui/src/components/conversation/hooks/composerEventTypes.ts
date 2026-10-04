import type { FormEvent } from "react";

export interface KeyboardEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
}

/** Both React's event and Lexical's native keyboard command use this contract. */
export interface ComposerKeyEvent extends KeyboardEventLike {
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing: boolean; keyCode: number };
}

export type ComposerSubmit = (
  event: FormEvent<HTMLFormElement> | KeyboardEventLike,
) => void;
