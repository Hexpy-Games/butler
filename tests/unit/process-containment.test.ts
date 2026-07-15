import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { PosixCommandAdapter } from "../../packages/butler-agent/src/runtime/command/posix-command-adapter.ts";
import {
  powerShellInvocations,
  windowsProcessHostExecutable,
} from "../../packages/butler-agent/src/runtime/command/powershell-command-adapter.ts";

test("Windows command adapter routes argv through the bundled Job Object host", () => {
  const request = {
    plan: {
      steps: [
        {
          executable: "C:\\Program Files\\Butler\\runtime\\bun.exe",
          arguments: ["-e", "process.stdout.write(process.argv[1])", "한글 & space"],
        },
      ] as const,
    },
  };
  expect(
    powerShellInvocations(request, "C:\\Butler\\butler-process-host.exe"),
  ).toEqual([
    {
      executable: "C:\\Butler\\butler-process-host.exe",
      arguments: [
        "C:\\Program Files\\Butler\\runtime\\bun.exe",
        "-e",
        "process.stdout.write(process.argv[1])",
        "한글 & space",
      ],
    },
  ]);
  expect(
    windowsProcessHostExecutable({
      BUTLER_WINDOWS_PROCESS_HOST: "C:\\override\\host.exe",
    }),
  ).toBe("C:\\override\\host.exe");
});

test.skipIf(process.platform === "win32")(
  "POSIX adapter cancellation kills the descendant process group and releases its port",
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "butler-process-group-"));
    try {
      const port = await availablePort();
      const readyPath = join(tempDir, "descendant-ready.txt");
      const childSource = [
        "const {writeFileSync}=require('node:fs')",
        "const {createServer}=require('node:net')",
        "const server=createServer(() => {})",
        "server.listen(Number(process.argv[1]), '127.0.0.1', () => writeFileSync(process.argv[2], String(process.pid)))",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const parentSource = [
        "const {spawn}=require('node:child_process')",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, ${JSON.stringify(String(port))}, ${JSON.stringify(readyPath)}], {stdio:'ignore'})`,
        "process.on('SIGTERM', () => {})",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const controller = new AbortController();
      const execution = new PosixCommandAdapter().execute({
        plan: {
          steps: [{ executable: process.execPath, arguments: ["-e", parentSource] }],
        },
        signal: controller.signal,
        timeoutMs: 5_000,
      });

      await waitFor(() => existsSync(readyPath), 2_000);
      const descendantPid = Number(readFileSync(readyPath, "utf8"));
      expect(await canConnect(port)).toBe(true);
      controller.abort();
      const result = await execution;
      await waitFor(() => !processAlive(descendantPid), 2_000);

      expect(result).toMatchObject({ cancelled: true, exitCode: null });
      expect(processAlive(descendantPid)).toBe(false);
      expect(await canConnect(port)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for process state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
