import { expect, test } from "bun:test";
import {
  archiveTargetPath,
  assertSafeExtractionTarget,
  managedRuntimeExecutablePath,
  normalizeArchivePath,
  pathIsInside,
  removeStaleRuntimeSiblingsSync,
  renameWithRetrySync,
  safeArchiveSymlinkTarget,
} from "../../packages/butler-app/client/electron/runtime-filesystem.mjs";

test("runtime filesystem resolves platform executable names without caller branching", () => {
  expect(
    managedRuntimeExecutablePath("C:\\Users\\테스터 Kim\\Butler", "win32"),
  ).toBe(
    "C:\\Users\\테스터 Kim\\Butler\\packages\\butler-agent\\resources\\runtime\\bin\\bun.exe",
  );
  expect(managedRuntimeExecutablePath("/Users/테스터 Kim/Butler", "darwin")).toBe(
    "/Users/테스터 Kim/Butler/packages/butler-agent/resources/runtime/bin/bun",
  );
});

test("runtime filesystem handles Windows drive UNC case and long paths", () => {
  expect(
    pathIsInside("C:\\Butler\\Data", "c:\\butler\\data\\Agent", "win32"),
  ).toBe(true);
  expect(
    pathIsInside("C:\\Butler\\Data", "C:\\Butler\\Database", "win32"),
  ).toBe(false);
  expect(
    pathIsInside(
      "\\\\server\\share\\Butler Data",
      "\\\\SERVER\\SHARE\\butler data\\에이전트",
      "win32",
    ),
  ).toBe(true);
  const longRoot = `\\\\?\\C:\\Users\\테스터\\${"long-segment\\".repeat(24)}Butler`;
  expect(pathIsInside(longRoot, `${longRoot}\\runtime\\bun.exe`, "win32")).toBe(
    true,
  );
});

test("runtime filesystem rejects traversal aliases and Windows device paths", () => {
  const unsafe = [
    "../escape",
    "/absolute",
    "C:/escape",
    "//server/share",
    "dir\\escape",
    "payload/file:stream",
    "payload/NUL.txt",
    "payload/trailing. ",
  ];
  for (const entry of unsafe) {
    expect(() => normalizeArchivePath(entry, "win32")).toThrow("unsafe");
  }
  expect(normalizeArchivePath("./payload/한글 file.txt", "win32")).toBe(
    "payload/한글 file.txt",
  );
  expect(
    archiveTargetPath("C:\\Butler Data", "payload/한글 file.txt", "win32"),
  ).toBe("C:\\Butler Data\\payload\\한글 file.txt");
});

test("runtime filesystem rejects Windows archive links and reparse-point parents", () => {
  expect(() =>
    safeArchiveSymlinkTarget(
      "C:\\Butler",
      "C:\\Butler\\link",
      "target",
      "win32",
    ),
  ).toThrow("must not contain links");
  expect(
    safeArchiveSymlinkTarget(
      "/butler",
      "/butler/link",
      "bin/butler.js",
      "linux",
    ),
  ).toBe("bin/butler.js");
  expect(() =>
    assertSafeExtractionTarget("C:\\Butler", "C:\\Butler\\payload\\file", {
      platform: "win32",
      lstat: () => ({ isSymbolicLink: () => true }),
      realpath: (value: string) => value,
    }),
  ).toThrow("reparse point");
});

test("runtime filesystem retries transient Windows rename failures only", () => {
  let calls = 0;
  const delays: number[] = [];
  renameWithRetrySync("from", "to", {
    platform: "win32",
    rename() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    delay(milliseconds: number) {
      delays.push(milliseconds);
    },
  });
  expect(calls).toBe(3);
  expect(delays).toEqual([25, 50]);
  expect(() =>
    renameWithRetrySync("from", "to", {
      platform: "linux",
      rename() {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      delay() {
        throw new Error("POSIX rename must not retry");
      },
    }),
  ).toThrow("busy");
});

test("runtime filesystem removes only stale staging and backup siblings", () => {
  const removed: string[] = [];
  removeStaleRuntimeSiblingsSync("C:\\Data\\versions\\1.2.3", {
    platform: "win32",
    now: 100_000,
    maxAgeMs: 1_000,
    entries: [
      { name: "1.2.3.staging-old", mtimeMs: 90_000 },
      { name: "1.2.3.previous-new", mtimeMs: 99_500 },
      { name: "1.2.4.staging-old", mtimeMs: 0 },
    ],
    remove(path: string) {
      removed.push(path);
    },
    exists: () => true,
  });
  expect(removed).toEqual(["C:\\Data\\versions\\1.2.3.staging-old"]);
});

test("runtime filesystem restores the newest crash backup before stale cleanup", () => {
  const renamed: string[] = [];
  const removed: string[] = [];
  const result = removeStaleRuntimeSiblingsSync("C:\\Data\\versions\\1.2.3", {
    platform: "win32",
    now: 100_000,
    maxAgeMs: 1_000,
    entries: [
      { name: "1.2.3.previous-old", mtimeMs: 80_000 },
      { name: "1.2.3.previous-newest", mtimeMs: 90_000 },
      { name: "1.2.3.staging-old", mtimeMs: 70_000 },
    ],
    exists: () => false,
    rename(source: string, target: string) {
      renamed.push(`${source} -> ${target}`);
    },
    remove(path: string) {
      removed.push(path);
    },
  });
  expect(result).toEqual({ recoveredBackup: "1.2.3.previous-newest" });
  expect(renamed).toEqual([
    "C:\\Data\\versions\\1.2.3.previous-newest -> C:\\Data\\versions\\1.2.3",
  ]);
  expect(removed).toEqual([
    "C:\\Data\\versions\\1.2.3.previous-old",
    "C:\\Data\\versions\\1.2.3.staging-old",
  ]);
});
