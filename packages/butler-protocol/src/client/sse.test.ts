import { expect, test } from "bun:test";
import { createSseParser } from "./sse.ts";

// test-category: pure-logic
test("SSE frames preserve multiline data across field, CRLF and value chunk boundaries", () => {
  const parser = createSseParser();
  const frames = [
    ": comment\r\neve",
    "nt: heartbeat\r",
    "\ndata: null\r\n\r\nid: 6\r\ndata: fir",
    "st\r\ndata: second\r\n\r\n",
  ].flatMap(chunk => parser.push(chunk));
  expect(frames).toEqual([
    { event: "heartbeat", data: "null", id: undefined },
    { event: "message", data: "first\nsecond", id: "6" },
  ]);
});
