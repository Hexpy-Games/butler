export const COMPOSER_FOCUS_EVENT = "butler:composer-focus";
export type ComposerFocusPlacement = "restore" | "end";

/** Route focus to the mounted editor, which owns its selection and IME state. */
export function focusComposer(element: HTMLElement | null | undefined, placement: ComposerFocusPlacement = "end") {
  element?.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: placement }));
}
