/// <reference types="bun" />

import { expect, test } from "bun:test";
import { normalizeAllowedHost } from "./allowedHostName";

/** The gateway's allowed-host table (#275 `normalize_allowed_host`). */
test("allowed hosts are names or addresses with an optional port", () => {
  const cases: Array<[string, string | null]> = [
    [" Butler.Example.Info ", "butler.example.info"],
    ["butler.local:18765", "butler.local:18765"],
    ["192.0.2.8", "192.0.2.8"],
    ["[fd00::1]:443", "[fd00::1]:443"],
    ["[::1]", "[::1]"],
    ["", null],
    ["   ", null],
    ["https://butler.example.info", null],
    ["butler.example.info/path", null],
    ["user@butler.example.info", null],
    ["butler.example.info:0", null],
    ["butler.example.info:99999", null],
    ["fd00::1", null],
    ["[fd00::zz]", null],
    ["-bad.example", null],
    ["two words", null],
  ];
  for (const [input, expected] of cases) {
    expect(normalizeAllowedHost(input), JSON.stringify(input)).toBe(expected);
  }
});
