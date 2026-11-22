// test-category: pure-logic
import { expect, test } from "bun:test";
import { pageIconSrc } from "../../packages/butler-app/client/ui/src/app/favicons";

test("page icons use the site proxy, preserve local icons, and omit missing icons", () => {
  expect(pageIconSrc("https://cdn.example.net/i.png", "https://www.example.com/a")).toBe("/favicons?host=www.example.com");
  expect(pageIconSrc("http://127.0.0.1:5173/favicon.svg", "http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/favicon.svg");
  expect(pageIconSrc("", "https://www.example.com/")).toBeUndefined();
});
