// The native gateway harness must never leak processes: every tracked child
// (and its process group) is killed and its temp dirs removed on stop, normal
// exit, SIGINT, SIGTERM, an uncaught exception, and test-runner teardown.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveTrackedProcessIds, spawnTrackedProcess, stopAllTrackedProcesses } from "../support/native-app-server.ts";

const helper = resolve(import.meta.dir, "../support/native-app-server.ts");
const scratch = mkdtempSync(join(tmpdir(), "butler-harness-exit-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return !alive(pid);
}

/** A dummy "gateway": ignores SIGTERM-free idling and forks a grandchild in its group. */
const DUMMY = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' });",
  "console.log(JSON.stringify({ grandchild: grandchild.pid }));",
  "setInterval(() => {}, 1000);",
].join("\n");

async function readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, number>> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
    if (line) return JSON.parse(line);
  }
  throw new Error(`no JSON line: ${buffer}`);
}

test("stop kills the exact child, its process group, and removes its temp dirs", async () => {
  const tempDir = mkdtempSync(join(scratch, "handle-"));
  const tracked = spawnTrackedProcess(process.execPath, ["-e", DUMMY], { cleanupPaths: [tempDir] });
  const { grandchild } = await readJsonLine(tracked.child.stdout!);
  expect(liveTrackedProcessIds()).toContain(tracked.pid);
  expect(alive(tracked.pid)).toBe(true);
  expect(alive(grandchild!)).toBe(true);

  await tracked.stop();

  expect(await gone(tracked.pid)).toBe(true);
  expect(await gone(grandchild!)).toBe(true);
  expect(existsSync(tempDir)).toBe(false);
  expect(liveTrackedProcessIds()).not.toContain(tracked.pid);
}, 30_000);

test("stopAllTrackedProcesses (the test-runner teardown hook) stops every live child", async () => {
  const first = spawnTrackedProcess(process.execPath, ["-e", DUMMY]);
  const second = spawnTrackedProcess(process.execPath, ["-e", DUMMY]);
  const grandchildren = await Promise.all([first, second].map(async (tracked) => (await readJsonLine(tracked.child.stdout!)).grandchild!));
  await stopAllTrackedProcesses();
  for (const pid of [first.pid, second.pid, ...grandchildren]) expect(await gone(pid)).toBe(true);
  expect(liveTrackedProcessIds()).toEqual([]);
}, 30_000);

const OWNER = (mode: string, tempDir: string) => `
import { spawnTrackedProcess } from ${JSON.stringify(helper)};
const tracked = spawnTrackedProcess(process.execPath, ["-e", ${JSON.stringify(DUMMY)}], { cleanupPaths: [${JSON.stringify(tempDir)}] });
let buffer = "";
for await (const chunk of tracked.child.stdout) {
  buffer += String(chunk);
  if (buffer.includes("\\n")) break;
}
const { grandchild } = JSON.parse(buffer.split("\\n")[0]);
console.log(JSON.stringify({ child: tracked.pid, grandchild }));
${mode === "exit" || mode === "throw"
  // Wait for the test's go-ahead: ending right after the JSON line would race
  // the test's "child is alive" check against this owner's own cleanup.
  ? `await new Promise((resume) => process.stdin.once("data", resume));\n${mode === "exit" ? "process.exit(0);" : "setTimeout(() => { throw new Error(\"harness crash\"); }, 0);"}`
  : "setInterval(() => {}, 1000);"}
`;

for (const mode of ["exit", "throw", "SIGINT", "SIGTERM"] as const) {
  test(`an owning process that ends by ${mode} leaves no tracked child behind`, async () => {
    const tempDir = mkdtempSync(join(scratch, `owner-${mode}-`));
    const script = join(scratch, `owner-${mode}.ts`);
    writeFileSync(script, OWNER(mode, tempDir));
    const owner = spawn(process.execPath, ["run", script], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => owner.once("exit", (code) => done(code)));
    try {
      const { child, grandchild } = await readJsonLine(owner.stdout!);
      expect(alive(child!)).toBe(true);
      expect(alive(grandchild!)).toBe(true);
      if (mode === "SIGINT" || mode === "SIGTERM") owner.kill(mode);
      else owner.stdin!.end("go\n");
      await exited;
      expect(await gone(child!)).toBe(true);
      expect(await gone(grandchild!)).toBe(true);
      expect(existsSync(tempDir)).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    }
  }, 30_000);
}
