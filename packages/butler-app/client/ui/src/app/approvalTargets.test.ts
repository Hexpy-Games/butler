import { expect, test } from "bun:test";
import { approvalTargetsFromTransport } from "./approvalTargets";

// test-category: pure-logic
test("approval paths preserve outside locations, drive paths, and root boundaries", () => {
  for (const [root, inside, outside] of [
    ["/home/mina/.butler", "/home/mina/.butler/notes.txt", "/tmp/reports/notes.txt"],
    ["C:\\Users\\mina\\garden", "C:\\Users\\mina\\garden\\notes.txt", "D:\\reports\\notes.txt"],
    ["/work/garden", "/work/garden/notes.txt", "/work/garden-old/notes.txt"],
    ["/work/garden", "/work/garden/notes.txt", "/work/garden/../notes.txt"],
  ]) {
    const { targets, relative } = approvalTargetsFromTransport([
      { kind: "folder", path: root }, { kind: "file", path: inside }, { kind: "outside", path: outside },
    ]);
    expect(targets).toEqual([
      { kind: "folder", path: "", label: root }, { kind: "file", path: "notes.txt" }, { kind: "outside", path: outside },
    ]);
    expect(relative(outside)).toBe(outside);
  }
  expect(approvalTargetsFromTransport([{ kind: "file", path: "/etc/hosts" }]).targets[0].path).toBe("/etc/hosts");
});
