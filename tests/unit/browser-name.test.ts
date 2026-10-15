// test-category: pure-logic
import { expect, test } from "bun:test";
import { normalizeBrowserName } from "../../packages/butler-app/client/electron/butler-platform/browser-name.mjs";

test("protocol handler names are readable browser display names", () => {
  for (const [input, expected] of [
    [" Safari.app ", "Safari"], ["Google Chrome.app", "Google Chrome"],
    ["Microsoft Edge.app", "Microsoft Edge"], ["chrome.exe", "Google Chrome"],
    ["msedge.EXE", "Microsoft Edge"], ["Firefox.exe", "Firefox"],
    ["Brave Browser", "Brave Browser"], ["", ""],
  ]) expect(normalizeBrowserName(input)).toBe(expected);
});
