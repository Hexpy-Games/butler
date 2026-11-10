/// <reference lib="dom" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
    conversationBottomLockAfterScroll,
    isConversationPinnedToBottom,
    scrollConversationToBottom,
} from "../../packages/butler-app/client/ui/src/components/conversation/conversationScrollUtils.ts";

const lock = (wasPinned: boolean, distanceFromBottom: number, userScrollIntent: boolean, movedUp: boolean) =>
  conversationBottomLockAfterScroll({ wasPinned, distanceFromBottom, userScrollIntent, movedUp });

test("layout-driven growth keeps the bottom lock until the reader scrolls up, however near the end", () => {
  expect(lock(true, 360, false, false)).toBe(true);
  expect(lock(true, 360, true, true)).toBe(false);
  expect(lock(true, 40, true, true)).toBe(false);
});

test("only the reader returning to the end re-locks a conversation they moved upward", () => {
  expect(lock(false, 360, false, false)).toBe(false);
  expect(lock(false, 20, false, false)).toBe(false);
  expect(lock(false, 20, true, false)).toBe(true);
  expect(lock(false, 0, false, false)).toBe(true);
});

test("conversation scroll utility detects bottom distance and scrolls smoothly to the latest area", () => {
  const dom = new JSDOM("<!doctype html><html><body><div></div></body></html>");
  const scrollElement = dom.window.document.querySelector(
    "div",
  ) as HTMLDivElement;
  const lastScrollTo: { current: ScrollToOptions | null } = { current: null };
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(scrollElement, "scrollTo", {
    configurable: true,
    value(options: ScrollToOptions) {
      lastScrollTo.current = options;
      scrollElement.scrollTop = Number(options.top ?? 0);
    },
  });

  scrollElement.scrollTop = 120;
  expect(isConversationPinnedToBottom(scrollElement)).toBe(false);

  const targetTop = scrollConversationToBottom(scrollElement, 1000, {
    behavior: "smooth",
  });

  expect(targetTop).toBe(700);
  expect(lastScrollTo.current).toEqual({ top: 700, behavior: "smooth" });
  expect(isConversationPinnedToBottom(scrollElement)).toBe(true);
});
