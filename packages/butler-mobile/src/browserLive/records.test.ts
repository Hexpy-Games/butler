// test-category: pure-logic
import { expect, test } from "bun:test";
import { LiveRecordParser } from "./records";

test("parses a record split at every byte offset", () => {
  const bytes = Uint8Array.of(2, 0, 0, 0, 3, 255, 216, 217);
  const record = { type: 2, payload: bytes.slice(5) };
  for (let offset = 0; offset <= bytes.length; offset++) {
    const parser = new LiveRecordParser();
    expect([
      ...parser.push(bytes.subarray(0, offset)),
      ...parser.push(bytes.subarray(offset)),
    ]).toEqual([record]);
  }
});

test("parses multiple records in one chunk", () => {
  expect(new LiveRecordParser().push(Uint8Array.of(1, 0, 0, 0, 1, 123, 3, 0, 0, 0, 0))).toEqual([
    { type: 1, payload: Uint8Array.of(123) }, { type: 3, payload: new Uint8Array() },
  ]);
});

test("rejects a record longer than 2 MiB", () => {
  expect(() => new LiveRecordParser().push(Uint8Array.of(2, 0, 32, 0, 1))).toThrow();
});
