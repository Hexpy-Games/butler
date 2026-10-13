import { afterEach, expect, test } from "bun:test";
import { gatewayImageSource } from "../../packages/butler-app/client/ui/src/app/messageFileUrls.ts";

const signed = "/message-assets/img_20o1dfj3nh?expires=1791829861&signature=abc";
const scope = globalThis as { window?: { butlerApp?: { serverUrl?: string } } };
const original = scope.window;

afterEach(() => { scope.window = original; });

// test-category: pure-logic
test("collected answer images load from the desktop gateway, not the app origin", () => {
  scope.window = { ...original, butlerApp: { serverUrl: "http://127.0.0.1:29765/" } };
  expect(gatewayImageSource(signed)).toBe(`http://127.0.0.1:29765${signed}`);
  scope.window = { ...original, butlerApp: undefined };
  expect(gatewayImageSource(signed)).toBe(signed);
  expect(gatewayImageSource(undefined)).toBeUndefined();
});
