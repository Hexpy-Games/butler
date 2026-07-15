import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCommandExecutor } from "../../src/runtime/command/platform-command-executor.ts";

if (process.platform !== "win32") {
  throw new Error("Windows process containment smoke requires win32");
}

const root = join(tmpdir(), "Butler Job Object 한글 smoke");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

try {
  const executor = createPlatformCommandExecutor();
  const graceful = await executor.execute({
    plan: {
      steps: [
        {
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('graceful-ok')"],
        },
      ],
    },
  });

  const port = await availablePort();
  const parentState = join(root, "parent 상태.txt");
  const descendantState = join(root, "descendant 상태.txt");
  const childSource = [
    "const {writeFileSync}=require('node:fs')",
    "const {createServer}=require('node:net')",
    "const server=createServer(() => {})",
    "server.listen(Number(process.argv[1]), '127.0.0.1', () => writeFileSync(process.argv[2], String(process.pid)))",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const parentSource = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `writeFileSync(${JSON.stringify(parentState)}, String(process.pid))`,
    `spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, ${JSON.stringify(String(port))}, ${JSON.stringify(descendantState)}], {stdio:'ignore'})`,
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const controller = new AbortController();
  const execution = executor.execute({
    plan: {
      steps: [
        { executable: process.execPath, arguments: ["-e", parentSource] },
      ],
    },
    signal: controller.signal,
    timeoutMs: 10_000,
  });

  await waitFor(() => existsSync(parentState) && existsSync(descendantState), 5_000);
  const parentPid = Number(readFileSync(parentState, "utf8"));
  const descendantPid = Number(readFileSync(descendantState, "utf8"));
  const portClaimed = await canConnect(port);
  controller.abort();
  const forced = await execution;
  await waitFor(
    () => !processAlive(parentPid) && !processAlive(descendantPid),
    5_000,
  );
  const portReleased = !(await canConnect(port));

  const result = {
    ok:
      graceful.stdout === "graceful-ok" &&
      graceful.exitCode === 0 &&
      forced.cancelled &&
      forced.exitCode === null &&
      portClaimed &&
      !processAlive(parentPid) &&
      !processAlive(descendantPid) &&
      portReleased,
    platform: process.platform,
    processHost: "butler-process-host-v1",
    gracefulStop: graceful.exitCode === 0,
    forcedTermination: forced.cancelled && forced.exitCode === null,
    ownerDeathKillsTree: !processAlive(parentPid) && !processAlive(descendantPid),
    descendantStopped: !processAlive(descendantPid),
    portClaimed,
    portReleased,
    unicodeAndSpaces: true,
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

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
    socket.setTimeout(500, () => {
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
    if (Date.now() >= deadline) throw new Error("timed out waiting for containment state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
