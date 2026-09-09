import { create } from "zustand";

interface ConfirmationOptions {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

interface ConfirmationRequest extends ConfirmationOptions {
  message: string;
  returnFocus: HTMLElement | null;
  resolve: (accepted: boolean) => void;
}

export const useConfirmationStore = create<{
  pending: ConfirmationRequest | null;
}>(() => ({ pending: null }));

/** Renderer-owned replacement for window.confirm; dismissal never accepts. */
export function confirmAction(
  message: string,
  options: ConfirmationOptions = {},
): Promise<boolean> {
  useConfirmationStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    const request: ConfirmationRequest = {
      ...options,
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
