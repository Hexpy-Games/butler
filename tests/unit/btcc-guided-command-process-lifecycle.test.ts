import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { executeGuidedCommand } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-command/execute-command.ts";

const OBSERVATION_LIMIT_MS = 1_800;

test.skipIf(process.platform === "win32")(
  "guided command force-terminates a timed-out process group that ignores SIGTERM",
  async () => {
    const fixture = commandGroupFixture();
    let execution: ReturnType<typeof executeGuidedCommand> | undefined;
    try {
      execution = executeGuidedCommand({
        command: `exec ${shellArg(process.execPath)} ${shellArg(fixture.parentScript)}`,
        timeout_ms: 200,
      }, commandContext(fixture.root));

      await waitFor(() => existsSync(fixture.readyPath), 1_000);
      const result = await within(execution, OBSERVATION_LIMIT_MS);
      const descendantPid = Number(readFileSync(fixture.readyPath, "utf8"));
      await waitFor(() => !processAlive(descendantPid), 1_000);

      expect(result.summary).toMatchObject({
        exitCode: null,
        timedOut: true,
      });
      expect(processAlive(descendantPid)).toBe(false);
    } finally {
      stopFixtureGroup(fixture.parentPidPath);
      await execution?.catch(() => undefined);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  5_000,
);

test.skipIf(process.platform === "win32")(
  "guided command preserves timeout when cancellation arrives during cleanup",
  async () => {
    const fixture = commandGroupFixture();
    const controller = new AbortController();
    const cancellation = new Error("test turn cancelled");
    let execution: ReturnType<typeof executeGuidedCommand> | undefined;
    try {
      execution = executeGuidedCommand({
        command: `exec ${shellArg(process.execPath)} ${shellArg(fixture.parentScript)}`,
        timeout_ms: 200,
      }, {
        ...commandContext(fixture.root),
        signal: controller.signal,
      });

      await waitFor(() => existsSync(fixture.readyPath), 1_000);
      const descendantPid = Number(readFileSync(fixture.readyPath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      controller.abort(cancellation);
      const result = await within(execution, OBSERVATION_LIMIT_MS);
      await waitFor(() => !processAlive(descendantPid), 1_000);

      expect(result.summary).toMatchObject({
        exitCode: null,
        timedOut: true,
      });
      expect(processAlive(descendantPid)).toBe(false);
    } finally {
      stopFixtureGroup(fixture.parentPidPath);
      await execution?.catch(() => undefined);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  5_000,
);

test.skipIf(process.platform === "win32")(
  "guided command preserves cancellation when timeout arrives during cleanup",
  async () => {
    const fixture = commandGroupFixture();
    const controller = new AbortController();
    const cancellation = new Error("test turn cancelled");
    let execution: ReturnType<typeof executeGuidedCommand> | undefined;
    try {
      execution = executeGuidedCommand({
        command: `exec ${shellArg(process.execPath)} ${shellArg(fixture.parentScript)}`,
        timeout_ms: 100,
      }, {
        ...commandContext(fixture.root),
        signal: controller.signal,
      });

      await waitFor(() => existsSync(fixture.readyPath), 1_000);
      const descendantPid = Number(readFileSync(fixture.readyPath, "utf8"));
      controller.abort(cancellation);
      await expect(within(execution, OBSERVATION_LIMIT_MS)).rejects.toBe(cancellation);
      await waitFor(() => !processAlive(descendantPid), 1_000);
      expect(processAlive(descendantPid)).toBe(false);
    } finally {
      stopFixtureGroup(fixture.parentPidPath);
      await execution?.catch(() => undefined);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  5_000,
);

test.skipIf(process.platform === "win32")(
  "guided command preserves a normal result before its configured timeout",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-guided-command-normal-"));
    try {
      const result = await executeGuidedCommand({
        command: `${shellArg(process.execPath)} -e ${shellArg("setTimeout(() => process.stdout.write('done'), 120)")}`,
        timeout_ms: 2_000,
      }, commandContext(root));

      expect(result.summary).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      expect(readFileSync(result.payloadSource.path, "utf8")).toContain("done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  5_000,
);

function commandGroupFixture(): {
  root: string;
  parentScript: string;
  parentPidPath: string;
  readyPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "butler-guided-command-group-"));
  const parentScript = join(root, "parent.mjs");
  const parentPidPath = join(root, "parent.pid");
  const readyPath = join(root, "descendant.pid");
  const descendantScript = join(root, "descendant.mjs");
  writeFileSync(descendantScript, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid))`,
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join("\n"));
  writeFileSync(parentScript, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid))`,
    `spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join("\n"));
  return { root, parentScript, parentPidPath, readyPath };
}

function commandContext(root: string) {
  return {
    butlerData: root,
    workspacePath: root,
    originalRequest: "Run the requested command.",
    accessMode: "full_access" as const,
    filesystemBoundary: { kind: "full_access_contained" as const },
  };
}

function shellArg(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("guided command did not settle after termination")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for process fixture");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopFixtureGroup(parentPidPath: string): void {
  if (!existsSync(parentPidPath)) return;
  const pid = Number(readFileSync(parentPidPath, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The production lifecycle already stopped the isolated fixture group.
  }
}
