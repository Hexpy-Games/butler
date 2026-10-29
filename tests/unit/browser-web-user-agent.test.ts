// test-category: format-pin
import { expect, test } from "bun:test";
import { webUserAgent } from "../../packages/butler-app/client/electron/butler-platform/browser-identity.mjs";

test("web tabs report reduced Chromium plus Butler/<major>, per platform", () => {
  const tail = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Butler/0";
  expect(webUserAgent("152.0.7977.130", "0.1.0", "darwin")).toBe(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`);
  expect(webUserAgent("152.0.7977.130", "0.1.0", "win32")).toBe(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`);
  expect(webUserAgent("152.0.7977.130", "0.1.0", "linux")).toBe(`Mozilla/5.0 (X11; Linux x86_64) ${tail}`);
});

test("the Butler token carries only the major version and never an Electron or Chrome-brand token", () => {
  const ua = webUserAgent("153.0.8000.1", "2.4.0-preview.13", "darwin");
  expect(ua.endsWith(" Chrome/153.0.0.0 Safari/537.36 Butler/2")).toBe(true);
  expect(ua).not.toMatch(/Electron|preview|Google Chrome/);
});
