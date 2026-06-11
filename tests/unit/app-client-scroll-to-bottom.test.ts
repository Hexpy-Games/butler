/// <reference lib="dom" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  isConversationPinnedToBottom,
  scrollConversationToBottom,
} from "../../packages/butler-app/client/ui/src/components/conversation/conversationScrollUtils.ts";

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

test("message list renders the production scroll-to-bottom affordance only from hook state", () => {
  const messageList = readSource(
    "packages/butler-app/client/ui/src/components/conversation/MessageList.tsx",
  );
  expect(messageList).toContain(
    "const scrollState = useConversationAutoScroll",
  );
  expect(messageList).toContain("scrollState.isAwayFromBottom");
  expect(messageList).toContain("<ScrollToBottomButton");
  expect(messageList).toContain(
    "hasUnreadMessages={scrollState.hasUnreadMessages}",
  );
  expect(messageList).toContain(
    'scrollState.scrollToBottom({ behavior: "smooth" })',
  );
});

test("scroll-to-bottom button source keeps the control accessible and concise", () => {
  const button = readSource(
    "packages/butler-app/client/ui/src/components/conversation/ScrollToBottomButton.ts",
  );
  const conversationShell = readSource(
    "packages/butler-app/client/ui/src/libs/design-system/blocks/ConversationShell/ConversationShell.tsx",
  );
  const copy = readSource("packages/butler-app/client/ui/src/app/copy.ts");

  expect(button).toContain("ConversationScrollToBottomButton");
  expect(button).toContain(
    "ariaLabel: appCopy.conversation.scrollToBottom.ariaLabel",
  );
  expect(conversationShell).toContain("import { PillButton }");
  expect(conversationShell).toContain("<PillButton");
  expect(conversationShell).not.toContain("<button");
  expect(conversationShell).toContain("aria-label={ariaLabel}");
  expect(conversationShell).toContain(
    'data-test-class="scroll-to-bottom-button"',
  );
  expect(conversationShell).toContain("data-unread-messages=");
  expect(conversationShell).toContain("icon={<ChevronDownIcon size={16} />}");
  expect(copy).toContain("Scroll to the latest message and composer");
  expect(copy).toContain("newMessagesLabel");
});

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
