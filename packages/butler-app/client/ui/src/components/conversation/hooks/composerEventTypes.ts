import type { FormEvent } from "react";

export interface KeyboardEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
}

export type ComposerSubmit = (
  event: FormEvent<HTMLFormElement> | KeyboardEventLike,
) => void;
