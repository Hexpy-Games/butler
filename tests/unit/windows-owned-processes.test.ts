// test-category: pure-logic
import { expect, test } from "bun:test";
import { fileRootBounds, resolveOwnedProcesses, type OwnedProcesses, type ProcessSnapshot } from "../../packages/butler-app/scripts/windows/installer-smoke-support.ts";

function row(pid: number, parentPid: number, created: number): ProcessSnapshot {
  return { pid, parentPid, created, name: "process.exe", path: null, commandLine: null };
}

test("a file root cannot own a process created after the file was written", () => {
  const owned: OwnedProcesses = new Map([[10, { notAfter: 100 }]]);
  expect(resolveOwnedProcesses(owned, [row(10, 0, 101)]).size).toBe(0);
  expect(owned.get(10)).toEqual({ notAfter: 100 });
});

test("a stale parent PID does not own a process older than that parent", () => {
  const owned: OwnedProcesses = new Map([[10, { created: 100, notAfter: 100 }]]);
  const resolved = resolveOwnedProcesses(owned, [row(10, 0, 100), row(20, 10, 99), row(30, 20, 101)]);
  expect([...resolved.keys()]).toEqual([10]);
});

test("genuine children are owned transitively regardless of snapshot order", () => {
  const owned: OwnedProcesses = new Map([[10, { notAfter: 100 }]]);
  const resolved = resolveOwnedProcesses(owned, [row(30, 20, 102), row(20, 10, 101), row(10, 0, 100)]);
  expect([...resolved]).toEqual([
    [10, { created: 100, notAfter: 100 }],
    [20, { created: 101, notAfter: 101 }],
    [30, { created: 102, notAfter: 102 }],
  ]);
});

test("a reused PID and a missing PID are dropped with their unowned descendants", () => {
  const owned: OwnedProcesses = new Map([
    [10, { created: 100, notAfter: 200 }], [40, { created: 100, notAfter: 200 }],
  ]);
  expect(resolveOwnedProcesses(owned, [row(10, 0, 101), row(20, 10, 102)]).size).toBe(0);
  expect(resolveOwnedProcesses(owned, [row(10, 0, 99)]).size).toBe(0);
});

test("matched identities retain their exact creation time and original bound", () => {
  const owned: OwnedProcesses = new Map([[10, { notAfter: 200 }]]);
  const resolved = resolveOwnedProcesses(owned, [row(10, 0, 123)]);
  expect(resolved.get(10)).toEqual({ created: 123, notAfter: 200 });
  expect(resolveOwnedProcesses(resolved, [row(10, 0, 123)]).get(10)).toEqual({ created: 123, notAfter: 200 });
  expect(resolveOwnedProcesses(resolved, [row(10, 0, 124)]).size).toBe(0);
});

test("a file rewrite naming the same PID keeps the bound of the write that first named it", () => {
  const first = fileRootBounds(undefined, [10, null, 0], 100);
  expect([...first]).toEqual([[10, 100]]);
  const rewritten = fileRootBounds(first, [10, 20], 300);
  expect([...rewritten]).toEqual([[10, 100], [20, 300]]);
  // A reused PID 10 created after the App exited (t=200) stays unowned after the rewrite.
  const owned: OwnedProcesses = new Map([[10, { notAfter: rewritten.get(10)! }]]);
  expect(resolveOwnedProcesses(owned, [row(10, 0, 200)]).size).toBe(0);
  // Once the file stops naming a PID, a later write naming it again gets a fresh bound.
  expect(fileRootBounds(fileRootBounds(rewritten, [20], 400), [10], 500).get(10)).toBe(500);
});
