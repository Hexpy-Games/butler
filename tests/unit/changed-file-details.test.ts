import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  aggregateChangedFileDetails,
  changedFileDetail,
} from "../../packages/butler-agent/src/agent/tools/file-tools/shared/changed-file-detail.ts";
import { collectGuidedChangedFiles } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-changed-files.ts";
import { withoutChangedFileDetails } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-tool-journal.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

test("changed-file details contain only added/deleted lines with old/new numbers", () => {
  expect(changedFileDetail("src/app.ts", "one\ntwo\n", "one\nthree\n"))
    .toMatchObject({
      path: "src/app.ts",
      additions: 1,
      deletions: 1,
      lines: [
        { type: "deleted", old_line: 2, content: "two" },
        { type: "added", new_line: 2, content: "three" },
      ],
    });
});

test("large shared bodies keep the changed line numbers after trimming", () => {
  const prefix = Array.from({ length: 2_000 }, (_, index) => `prefix-${index}`);
  const suffix = Array.from({ length: 2_000 }, (_, index) => `suffix-${index}`);
  const before = [...prefix, "old", ...suffix].join("\n");
  const after = [...prefix, "new", ...suffix].join("\n");

  expect(changedFileDetail("src/large.ts", before, after)?.lines).toEqual([
    { type: "deleted", old_line: 2_001, content: "old" },
    { type: "added", new_line: 2_001, content: "new" },
  ]);
});

test("repeated mutations aggregate to the final net diff and omit a reverted file", () => {
  const first = changedFileDetail("src/app.ts", "one\n", "two\n")!;
  const second = changedFileDetail("src/app.ts", "two\n", "three\n")!;
  expect(aggregateChangedFileDetails([first, second])).toEqual([{
    path: "src/app.ts",
    additions: 1,
    deletions: 1,
    lines: [
      { type: "deleted", old_line: 1, content: "one" },
      { type: "added", new_line: 1, content: "three" },
    ],
  }]);
  expect(aggregateChangedFileDetails([
    first,
    changedFileDetail("src/app.ts", "two\n", "one\n")!,
  ])).toEqual([]);
});

test("journal-private details drive final collection but are absent from replayable output", () => {
  const detail = changedFileDetail("src/app.ts", "old\n", "new\n")!;
  expect(collectGuidedChangedFiles([{
    callId: "call-1",
    toolName: "edit_file",
    rawArguments: "{}",
    arguments: {},
    status: "completed",
    result: { ok: true, path: "src/app.ts" },
    changedFiles: [detail],
  }])).toEqual([{
    path: "src/app.ts",
    additions: 1,
    deletions: 1,
    lines: [
      { type: "deleted", old_line: 1, content: "old" },
      { type: "added", new_line: 1, content: "new" },
    ],
  }]);
  expect(withoutChangedFileDetails({ ok: true, changed_file: detail, path: "src/app.ts" }))
    .toEqual({ ok: true, path: "src/app.ts" });
});

test("SQLite keeps changed lines separate from replayable tool results", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const journal = new SqliteGuidedToolJournal(db);
  const detail = changedFileDetail("src/app.ts", "old\n", "new\n")!;
  journal.start({
    turnId: "turn-1",
    callId: "call-1",
    toolName: "edit_file",
    rawArguments: "{}",
    arguments: {},
  });
  journal.finish({
    callId: "call-1",
    status: "completed",
    result: { ok: true, path: "src/app.ts" },
    changedFiles: [detail],
  });

  expect(journal.find("call-1")?.result).toEqual({ ok: true, path: "src/app.ts" });
  expect(journal.find("call-1")?.changedFiles).toEqual([detail]);
  db.close();
});
