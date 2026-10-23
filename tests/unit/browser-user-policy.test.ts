// test-category: security
import { expect, test } from "bun:test";
import { addressUrl, BROWSER_BUILD, browsingEnabled, createLossBreaker, webUrl } from "../../packages/butler-app/client/electron/browser/policy.mjs";

test("user navigation admits web URLs and search, never privileged protocols or credentials", () => {
  expect(addressUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(addressUrl("example.com")).toBe("https://example.com/");
  expect(addressUrl("localhost:8123/a")).toBe("http://localhost:8123/a");
  expect(addressUrl("버틀러 검색")).toBe("https://www.google.com/search?q=%EB%B2%84%ED%8B%80%EB%9F%AC%20%EA%B2%80%EC%83%89");
  for (const input of ["file:///etc/passwd", "javascript:alert(1)", "app://butler", "mailto:a@b.com", "data:text/html,a"]) {
    expect(webUrl(input)).toBeNull(); expect(() => addressUrl(input)).toThrow("blocked_protocol");
  }
  expect(webUrl("https://user:secret@example.com")).toBeNull();
});

// Private and local destinations default to http (no certificate there); public ones keep https.
test("scheme-less private and local addresses open over http, public ones over https", () => {
  const http: string[] = [
    "192.168.1.1", // privacy-hygiene: allow-private-ip
    "10.0.0.1/admin", // privacy-hygiene: allow-private-ip
    "172.20.0.5:8080", // privacy-hygiene: allow-private-ip
    "169.254.1.1", "100.64.0.1", "127.0.0.1:3000", "[::1]:3000", "[fd00::1]", "[fe80::1]",
    "router.local", "printer.home.arpa", "app.localhost:5173", "svc.internal", "nas:5000", "router/admin",
  ];
  for (const input of http) expect([input, addressUrl(input)]).toEqual([input, new URL(`http://${input}`).href]);
  for (const input of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700::1111]", "local.example.com"]) {
    expect([input, addressUrl(input)]).toEqual([input, new URL(`https://${input}`).href]);
  }
  expect(addressUrl("http://192.168.1.1")).toBe("http://192.168.1.1/"); // privacy-hygiene: allow-private-ip
  expect(addressUrl("https://192.168.1.1")).toBe("https://192.168.1.1/"); // privacy-hygiene: allow-private-ip
  expect(addressUrl("intranet")).toBe("https://www.google.com/search?q=intranet");
});

test("build support expires at EOL and fails closed for an unqualified major", () => {
  const end = Date.parse(BROWSER_BUILD.eol);
  expect(browsingEnabled("44.5.1", end - 1)).toBe(true);
  expect(browsingEnabled("44.5.1", end)).toBe(false);
  expect(browsingEnabled("41.10.4", end - 1)).toBe(false);
});

test("five GPU losses with web tabs trip once; losses outside the window and without tabs do not", () => {
  let clock = 0; let trips = 0;
  const breaker = createLossBreaker(() => trips++, () => clock);
  for (let i = 0; i < 5; i++) breaker.loss(false);
  expect(trips).toBe(0);
  for (let i = 0; i < 4; i++) breaker.loss(true);
  expect(breaker.tripped).toBe(false);
  clock = 600_001; breaker.loss(true);
  expect(trips).toBe(0);
  for (let i = 0; i < 4; i++) breaker.loss(true);
  expect(breaker.tripped).toBe(true); expect(trips).toBe(1);
  breaker.loss(true); expect(trips).toBe(1);
});
