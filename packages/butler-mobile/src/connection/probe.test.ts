import { expect, test } from "bun:test";
import { butlerOrigin, classify, type ProbeResult } from "./probe";

// test-category: pure-logic
test("a typed address becomes a plain http(s) origin", () => {
  const cases: [string, string | null][] = [
    ["192.168.0.5:18765", "http://192.168.0.5:18765"],
    ["  https://butler.example.com/ ", "https://butler.example.com"],
    ["butler.local", "http://butler.local"],
    ["", null],
    ["ftp://butler.example.com", null],
    ["http://butler.example.com/app", null],
    ["http://h?x=1", null],
  ];
  for (const [input, expected] of cases) expect(butlerOrigin(input)).toBe(expected);
});

// test-category: pure-logic
test("gateway answers map to what the app shows", () => {
  const v1 = "butler.app.v1";
  const error = (code: string) => ({ protocol_version: v1, error: { code, message: "m" } });
  const cases: [number, unknown, ProbeResult][] = [
    [200, { protocol_version: v1, data: { ok: true } }, { kind: "ready" }],
    [401, error("local_auth_required"), { kind: "needs_pairing" }],
    [403, error("host_not_allowed"), { kind: "host_not_allowed" }],
    [503, error("local_auth_unconfigured"), { kind: "error", code: "local_auth_unconfigured" }],
    [500, { protocol_version: v1 }, { kind: "error", code: "http_500" }],
    [200, { protocol_version: "butler.app.v2", data: {} }, { kind: "protocol_mismatch", server: "butler.app.v2" }],
    [200, "<html></html>", { kind: "not_butler" }],
    [404, null, { kind: "not_butler" }],
  ];
  for (const [status, body, expected] of cases) expect(classify(status, body)).toEqual(expected);
});
