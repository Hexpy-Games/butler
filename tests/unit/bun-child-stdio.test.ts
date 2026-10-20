// test-category: race
import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBunChildStdioRetention } from "../support/bun-child-stdio";

const childProcess: typeof import("node:child_process") = createRequire(import.meta.url)("node:child_process");

async function exitWithExtraPipe(): Promise<void> {
  const child = childProcess.spawn("/bin/sh", ["-c", "exit 0"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code).toBe(0);
}

function closeIfOpen(fd: number): void {
  try { closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
}

test("exited children with extra stdio cannot close reused fds during GC", async () => {
  const spawn = childProcess.spawn;
  installBunChildStdioRetention();
  expect(childProcess.spawn).toBe(spawn);
  const dir = mkdtempSync(join(tmpdir(), "bun-child-stdio-"));
  const fds: number[] = [];
  try {
    await exitWithExtraPipe(); // The helper's local child reference is now gone.
    for (let index = 0; index < 12; index++) fds.push(openSync(join(dir, String(index)), "w+"));
    Bun.gc(true);
    await Bun.sleep(10);
    Bun.gc(true);
    const closed = fds.filter(fd => {
      try { fstatSync(fd); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; return true; }
    });
    expect(closed).toEqual([]);
  } finally {
    for (const fd of fds) closeIfOpen(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
