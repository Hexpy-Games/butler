import { expect, test } from "bun:test";
import { updateFixtureWord } from "../support/update-work-fixture.ts";

// test-category: pure-logic
test("update fixture reads the current request before later user-role context", () => {
  expect(updateFixtureWord([
    { role: "user", content: "## Current request\nReply with exactly the word: waiting" },
    { role: "user", content: "Updated current Work context" },
  ])).toBe("waiting");
});

// test-category: pure-logic
test("update fixture prefers the newest request over legacy history", () => {
  expect(updateFixtureWord([
    { role: "user", content: "User request:\nReply with exactly the word: one" },
    { role: "assistant", content: "Reply with exactly the word: waiting" },
    { role: "user", content: [{ type: "text", text: "## Current request\nReply with exactly the word: done" }] },
    { role: "user", content: "Updated current Work context" },
  ])).toBe("done");
});

// test-category: pure-logic
test("update fixture retains legacy requests and excludes scope text", () => {
  expect(updateFixtureWord([{ role: "user", content:
    "User request:\nReply with exactly the word: one\nCurrent scope:\nReply with exactly the word: done",
  }])).toBe("one");
  expect(updateFixtureWord([{ role: "user", content:
    "User request:\nReply with exactly the word: one\n\n## Current request\nReply with exactly the word: done",
  }])).toBe("done");
});
