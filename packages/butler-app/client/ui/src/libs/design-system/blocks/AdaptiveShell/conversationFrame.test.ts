// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BROWSER_CHAT_WIDTH, clampBrowserChatWidth, MIN_PAGE_WIDTH, sidebarAutoCollapses, toggleConversationSidePanel,
} from "./conversationFrame";

test("the chat column clamps to 340–560 and matches the tokens", () => {
  expect([clampBrowserChatWidth(200), clampBrowserChatWidth(400.4), clampBrowserChatWidth(900)]).toEqual([340, 400, 560]);
  const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
  const px = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)px`, "u").exec(tokens)?.[1]);
  expect({ min: px("--browser-chat-width-min"), default: px("--browser-chat-width"), max: px("--browser-chat-width-max") })
    .toEqual({ ...BROWSER_CHAT_WIDTH });
});

test("the browser pane and the inspector are mutually exclusive", () => {
  expect(toggleConversationSidePanel(null, "browser")).toBe("browser");
  expect(toggleConversationSidePanel("inspector", "browser")).toBe("browser");
  expect(toggleConversationSidePanel("browser", "inspector")).toBe("inspector");
  expect(toggleConversationSidePanel("browser", "browser")).toBeNull();
});

test("the sidebar steps aside below a 720px page and returns with a margin", () => {
  const frame = { sidebarWidth: 304, chatWidth: 400 };
  expect(MIN_PAGE_WIDTH).toBe(720);
  expect(sidebarAutoCollapses({ ...frame, shellWidth: 1440, collapsed: false })).toBe(false);
  expect(sidebarAutoCollapses({ ...frame, shellWidth: 1400, collapsed: false })).toBe(true);
  // 1440 - 304 - 400 = 736: wide enough to stay, not wide enough to come back.
  expect(sidebarAutoCollapses({ ...frame, shellWidth: 1440, collapsed: true })).toBe(true);
  expect(sidebarAutoCollapses({ ...frame, shellWidth: 1460, collapsed: true })).toBe(false);
});
