import { create } from "zustand";

/** The user must type `phrase` before the confirm button activates. */
export interface TypedConfirmation {
  phrase: string;
  label: string;
  mismatchTooltip: string;
}

interface ConfirmationOptions {
  title?: string;
  confirmLabel?: string;
  /** Replaces the cancel button's label, when choosing it is an answer of its own. */
  cancelLabel?: string;
  destructive?: boolean;
  details?: Array<{ label?: string; text: string; caption?: string }>;
  note?: string;
  typedConfirmation?: TypedConfirmation;
}

export interface ConfirmationRequest extends ConfirmationOptions {
  /** Distinguishes requests so per-request input state starts empty. */
  id: number;
  message: string;
  returnFocus: HTMLElement | null;
  resolve: (accepted: boolean) => void;
  /** The cancel button: for `chooseAction`, an answer rather than a dismissal. */
  decline: () => void;
}

export type ConfirmationChoice = "confirmed" | "declined" | "dismissed";

export const useConfirmationStore = create<{
  pending: ConfirmationRequest | null;
}>(() => ({ pending: null }));

let nextRequestId = 0;

/** Typed confirmation compares NFC-normalized, trimmed text exactly. */
export function normalizeConfirmationText(value: string): string {
  return value.normalize("NFC").trim();
}

export function typedConfirmationMatches(value: string, phrase: string): boolean {
  return normalizeConfirmationText(value) === normalizeConfirmationText(phrase);
}

function ask(message: string, options: ConfirmationOptions, settle: (choice: ConfirmationChoice) => void): void {
  useConfirmationStore.getState().pending?.resolve(false);
  const finish = (choice: ConfirmationChoice) => {
    if (useConfirmationStore.getState().pending === request) {
      useConfirmationStore.setState({ pending: null });
    }
    settle(choice);
  };
  const request: ConfirmationRequest = {
    ...options,
    id: ++nextRequestId,
    message,
    returnFocus: document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
    resolve: (accepted) => finish(accepted ? "confirmed" : "dismissed"),
    decline: () => finish("declined"),
  };
  useConfirmationStore.setState({ pending: request });
}

/** Renderer-owned replacement for window.confirm; dismissal never accepts. */
export function confirmAction(
  message: string,
  options: ConfirmationOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => ask(message, options, (choice) => resolve(choice === "confirmed")));
}

/** The same dialog where the cancel button is an answer, and closing it is none. */
export function chooseAction(
  message: string,
  options: ConfirmationOptions = {},
): Promise<ConfirmationChoice> {
  return new Promise((resolve) => ask(message, options, resolve));
}
