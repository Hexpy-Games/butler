import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { basename, resolve } from "node:path";

const timeoutMs = 20_000;

type OwnerReady = {
  ownerPid: number;
  workerPid: number;
  descendantPid: number;
  port: number;
};

type RunningOwner = {
  process: ChildProcessWithoutNullStreams;
  ready: OwnerReady;
  pipePath: string;
  token: string;
  targetId: string;
};

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("This smoke test must run on Windows.");
  }
  const expectedRuntime =
    process.env.BUTLER_WINDOWS_POC_EXPECTED_RUNTIME?.trim() ?? process.execPath;
  if (normalizeWindowsPath(process.execPath) !== normalizeWindowsPath(expectedRuntime)) {
    throw new Error("Smoke test was not launched by the expected bundled runtime.");
  }
  assertStandardUserToken();

  const authenticated = await startOwner();
  try {
    const wrongToken = await requestCancellation(authenticated.pipePath, {
      action: "cancel",
      token: "invalid-token",
      targetId: authenticated.targetId,
    });
    if (wrongToken.error !== "unauthorized") {
      throw new Error("Cancellation IPC did not reject an invalid token.");
    }
    const wrongTarget = await requestCancellation(authenticated.pipePath, {
      action: "cancel",
      token: authenticated.token,
      targetId: "wrong-target",
    });
    if (wrongTarget.error !== "target_mismatch") {
      throw new Error("Cancellation IPC did not reject a mismatched target identity.");
    }
    if (!(await isPortOpen(authenticated.ready.port))) {
      throw new Error("Rejected cancellation request disturbed the contained process tree.");
    }
    const accepted = await requestCancellation(authenticated.pipePath, {
      action: "cancel",
      token: authenticated.token,
      targetId: authenticated.targetId,
    });
    if (accepted.ok !== true) throw new Error("Exact authenticated cancellation was rejected.");
    await assertOwnerTreeStopped(authenticated);
  } finally {
    stopOwner(authenticated.process);
  }

  const forced = await startOwner();
  try {
    if (!(await isPortOpen(forced.ready.port))) {
      throw new Error("Forced-close containment tree did not open its probe port.");
    }
    if (!forced.process.kill()) throw new Error("Failed to terminate the Job Object owner.");
    await assertOwnerTreeStopped(forced);
  } finally {
    stopOwner(forced.process);
  }

  const result = JSON.stringify({
    ok: true,
    platform: process.platform,
    runtime: basename(process.execPath),
    standardUser: true,
    jobObject: {
      killOnOwnerClose: true,
      workerStopped: true,
      descendantStopped: true,
      portReleased: true,
    },
    cancellationIpc: {
      transport: "windows-named-pipe",
      randomUserSecret: true,
      wrongTokenRejected: true,
      wrongTargetRejected: true,
      exactIdentityAccepted: true,
    },
    rawTextIncluded: false,
  });
  const resultFile =
    process.argv
      .find((argument) => argument.startsWith("--result-file="))
      ?.slice("--result-file=".length)
      .trim() ?? process.env.BUTLER_WINDOWS_POC_RESULT_FILE?.trim();
  if (resultFile) {
    await Bun.write(resultFile, `${result}\n`);
  } else {
    console.log(result);
  }
}

function assertStandardUserToken(): void {
  const result = spawnSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error("Unable to inspect the Windows process token integrity level.");
  }
  if (result.stdout.includes("S-1-16-12288") || result.stdout.includes("S-1-16-16384")) {
    throw new Error("Containment smoke must run with a non-elevated Windows token.");
  }
}

async function startOwner(): Promise<RunningOwner> {
  const port = await findAvailablePort();
  const token = randomBytes(32).toString("hex");
  const targetId = randomUUID();
  const pipePath = `\\\\.\\pipe\\butler-win-poc-${process.pid}-${randomUUID()}`;
  const ownerEntry = resolve(import.meta.dir, "poc/containment-owner.ts");
  const child = spawn(process.execPath, ["run", ownerEntry], {
    env: {
      ...process.env,
      BUTLER_WINDOWS_POC_PIPE: pipePath,
      BUTLER_WINDOWS_POC_TOKEN: token,
      BUTLER_WINDOWS_POC_TARGET: targetId,
      BUTLER_WINDOWS_POC_PORT: String(port),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.end();
  const ready = await waitForOwnerReady(child);
  if (!(await waitForPortState(ready.port, true, timeoutMs))) {
    stopOwner(child);
    throw new Error("Contained descendant did not open its probe port.");
  }
  return { process: child, ready, pipePath, token, targetId };
}

function waitForOwnerReady(child: ChildProcessWithoutNullStreams): Promise<OwnerReady> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for containment owner. stderr=${stderr}`));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Containment owner exited before readiness: ${code}. stderr=${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      const value = JSON.parse(stdout.slice(0, lineEnd)) as OwnerReady & { type?: string };
      if (
        value.type !== "owner-ready" ||
        !value.ownerPid ||
        !value.workerPid ||
        !value.descendantPid ||
        !value.port
      ) {
        cleanup();
        reject(new Error("Invalid containment owner readiness payload."));
        return;
      }
      cleanup();
      resolvePromise(value);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("exit", onExit);
  });
}

function requestCancellation(
  pipePath: string,
  request: Record<string, string>,
): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(pipePath);
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for cancellation IPC response."));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const lineEnd = response.indexOf("\n");
      if (lineEnd < 0) return;
      clearTimeout(timer);
      socket.end();
      resolvePromise(JSON.parse(response.slice(0, lineEnd)) as { ok?: boolean; error?: string });
    });
  });
}

async function assertOwnerTreeStopped(owner: RunningOwner): Promise<void> {
  if (!(await waitForProcessExit(owner.ready.ownerPid, timeoutMs))) {
    throw new Error("Containment owner remained alive after shutdown.");
  }
  if (!(await waitForProcessExit(owner.ready.workerPid, timeoutMs))) {
    throw new Error("Job Object worker survived owner shutdown.");
  }
  if (!(await waitForProcessExit(owner.ready.descendantPid, timeoutMs))) {
    throw new Error("Job Object descendant survived owner shutdown.");
  }
  if (!(await waitForPortState(owner.ready.port, false, timeoutMs))) {
    throw new Error("Contained process port remained open after owner shutdown.");
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a TCP port.");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

async function waitForProcessExit(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPortState(
  port: number,
  expectedOpen: boolean,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(port)) === expectedOpen) return true;
    await Bun.sleep(100);
  }
  return false;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function stopOwner(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function normalizeWindowsPath(path: string): string {
  return resolve(path).replaceAll("/", "\\").toLowerCase();
}

await main();
