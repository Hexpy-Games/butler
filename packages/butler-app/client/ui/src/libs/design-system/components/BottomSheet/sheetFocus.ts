import type { KeyboardEvent } from "react";

const TABBABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Tab and Shift+Tab wrap inside the sheet, so focus cannot reach the page behind the backdrop. */
export function loopSheetFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(TABBABLE))
    .filter((item) => item.offsetParent !== null || item === document.activeElement);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Closes a Radix menu, popover or select the way Escape does (its dismissable layer listens on the document). */
export function dismissLikeEscape(element: HTMLElement | null) {
  element?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
