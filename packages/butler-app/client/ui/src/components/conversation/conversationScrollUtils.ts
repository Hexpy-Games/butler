export const BOTTOM_LOCK_THRESHOLD = 120;
export const DEFAULT_SCROLL_BEHAVIOR: ScrollBehavior = "auto";

export interface ScrollToBottomOptions {
  behavior?: ScrollBehavior;
}

export function conversationDistanceFromBottom(
  element: Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function isConversationPinnedToBottom(
  element: Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  threshold = BOTTOM_LOCK_THRESHOLD,
): boolean {
  return conversationDistanceFromBottom(element) < threshold;
}

export function scrollConversationToBottom(
  element: HTMLDivElement,
  virtualListHeight: number,
  options?: ScrollToBottomOptions,
): number {
  const contentHeight = Math.max(element.scrollHeight, virtualListHeight);
  const top = Math.max(0, contentHeight - element.clientHeight);
  const behavior = options?.behavior ?? DEFAULT_SCROLL_BEHAVIOR;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top, behavior });
  } else {
    element.scrollTop = top;
  }
  return top;
}
