import type { KeyboardEvent } from "react";

/** Number keys focus an explicit decision; only Enter or a click executes it. */
export function composerDecisionKeyboard(event: KeyboardEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape") {
    // Keep the decision visible; never let a composer shortcut submit or deny it.
    event.stopPropagation();
    return;
  }
  if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
  const actions = event.currentTarget.querySelector('[data-slot="composer-decision-actions"]');
  const choices = actions?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-haspopup])');
  if (!choices?.length) return;
  if (/^[1-9]$/u.test(event.key) && Number(event.key) <= choices.length) {
    event.preventDefault(); event.stopPropagation();
    choices[Number(event.key) - 1]?.focus({ preventScroll: true });
  } else if (event.key === "Enter" && (event.target as HTMLElement).closest("button")) {
    event.preventDefault(); event.stopPropagation();
    (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.click();
  } else if (event.key === "Enter" && event.target === event.currentTarget) {
    event.preventDefault(); event.stopPropagation();
    choices[choices.length - 1]?.click();
  }
}
