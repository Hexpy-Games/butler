/// <reference lib="dom" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
    conversationBottomLockAfterScroll,
    isConversationPinnedToBottom,
    scrollConversationToBottom,
} from "../../packages/butler-app/client/ui/src/components/conversation/conversationScrollUtils.ts";

test("layout-driven active-row growth retains bottom lock until direct user scroll intent", () => {
  expect(
    conversationBottomLockAfterScroll({
      wasPinned: true,
      distanceFromBottom: 360,
      userScrollIntent: false,
    }),
  ).toBe(true);
  expect(
    conversationBottomLockAfterScroll({
      wasPinned: true,
      distanceFromBottom: 360,
      userScrollIntent: true,
    }),
  ).toBe(false);
});

test("work-block measurements do not repin a conversation the user already moved upward", () => {
  expect(
    conversationBottomLockAfterScroll({
      wasPinned: false,
      distanceFromBottom: 360,
      userScrollIntent: false,
    }),
  ).toBe(false);
  expect(
    conversationBottomLockAfterScroll({
      wasPinned: false,
      distanceFromBottom: 20,
      userScrollIntent: false,
    }),
  ).toBe(true);
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
