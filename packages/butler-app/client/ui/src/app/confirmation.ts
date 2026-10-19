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
}

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

/** Renderer-owned replacement for window.confirm; dismissal never accepts. */
export function confirmAction(
  message: string,
  options: ConfirmationOptions = {},
): Promise<boolean> {
  useConfirmationStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    const request: ConfirmationRequest = {
      ...options,
      id: ++nextRequestId,
      message,
      returnFocus: document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
      resolve: (accepted) => {
        if (useConfirmationStore.getState().pending === request) {
          useConfirmationStore.setState({ pending: null });
        }
        resolve(accepted);
      },
    };
    useConfirmationStore.setState({ pending: request });
  });
}
