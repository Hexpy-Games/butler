import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIncrementalJsonlSnapshot } from "../../packages/butler-agent/src/operations/metrics/incremental-jsonl-snapshot.ts";

test("incremental JSONL snapshots do not reparse unchanged files and parse only appended lines", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-jsonl-snapshot-"));
  const path = join(directory, "events.jsonl");
  let parseCalls = 0;
  const parse = (line: string): { value: number } => {
    parseCalls += 1;
    return JSON.parse(line) as { value: number };
  };
  try {
    writeFileSync(path, '{"value":1}\n', "utf8");
    expect(readIncrementalJsonlSnapshot(path, parse).values).toEqual([
      { value: 1 },
    ]);
    expect(parseCalls).toBe(1);
    expect(readIncrementalJsonlSnapshot(path, parse).values).toEqual([
      { value: 1 },
    ]);
    expect(parseCalls).toBe(1);

    appendFileSync(path, '{"value":2}\n', "utf8");
    expect(readIncrementalJsonlSnapshot(path, parse).values).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(parseCalls).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental JSONL snapshots bound retained entries and isolate paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-jsonl-snapshot-bound-"));
  const firstPath = join(directory, "first.jsonl");
  const secondPath = join(directory, "second.jsonl");
  try {
    writeFileSync(firstPath, '{"value":1}\n{"value":2}\n{"value":3}\n', "utf8");
    writeFileSync(secondPath, '{"value":9}\n', "utf8");
    expect(
      readIncrementalJsonlSnapshot(firstPath, (line) => JSON.parse(line), {
        maxEntries: 2,
      }).values,
    ).toEqual([{ value: 2 }, { value: 3 }]);
    expect(
      readIncrementalJsonlSnapshot(secondPath, (line) => JSON.parse(line))
        .values,
    ).toEqual([{ value: 9 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental JSONL snapshots count parser-rejected lines and retain the error on append", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-jsonl-snapshot-errors-"));
  const path = join(directory, "events.jsonl");
  let parseCalls = 0;
  const parse = (line: string): { value: number } | null => {
    parseCalls += 1;
    if (line.includes("malformed")) return null;
    return JSON.parse(line) as { value: number };
  };
  try {
    writeFileSync(path, '{"value":1}\nmalformed\n', "utf8");
    expect(readIncrementalJsonlSnapshot(path, parse)).toMatchObject({
      values: [{ value: 1 }],
      parseErrors: 1,
    });
    expect(parseCalls).toBe(2);
    expect(readIncrementalJsonlSnapshot(path, parse)).toMatchObject({
      values: [{ value: 1 }],
      parseErrors: 1,
    });
    expect(parseCalls).toBe(2);

    appendFileSync(path, '{"value":2}\n', "utf8");
    expect(readIncrementalJsonlSnapshot(path, parse)).toMatchObject({
      values: [{ value: 1 }, { value: 2 }],
      parseErrors: 1,
    });
    expect(parseCalls).toBe(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
