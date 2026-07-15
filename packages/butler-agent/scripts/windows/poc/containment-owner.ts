import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

import { createWindowsKillOnCloseJob } from "./windows-job-object.ts";

const pipePath = requireEnv("BUTLER_WINDOWS_POC_PIPE");
const token = requireEnv("BUTLER_WINDOWS_POC_TOKEN");
const targetId = requireEnv("BUTLER_WINDOWS_POC_TARGET");
const workerEntry = resolve(import.meta.dir, "containment-worker.ts");
const job = createWindowsKillOnCloseJob();
let jobClosed = false;

const worker = spawn(process.execPath, ["run", workerEntry], {
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

try {
  if (!worker.pid) throw new Error("Containment worker did not expose a PID.");
  job.assign(worker.pid);
  worker.stdin.end("start\n");
  const workerReady = await waitForWorker(worker);
  const server = createCancellationServer();
  await listen(server, pipePath);
  console.log(
    JSON.stringify({
      type: "owner-ready",
      ownerPid: process.pid,
      workerPid: workerReady.pid,
      descendantPid: workerReady.descendantPid,
      port: workerReady.port,
    }),
  );
  setInterval(() => undefined, 60 * 60 * 1000);
} catch (error) {
  closeJob();
  throw error;
}

function createCancellationServer(): Server {
  return createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const lineEnd = input.indexOf("\n");
      if (lineEnd < 0) return;
      const response = authorizeCancellation(input.slice(0, lineEnd));
      socket.end(`${JSON.stringify(response)}\n`, () => {
        if (!response.ok) return;
        setTimeout(() => {
          closeJob();
          socket.unref();
          process.exit(0);
        }, 25);
      });
    });
  });
}

function authorizeCancellation(raw: string): {
  ok: boolean;
  error?: "invalid_request" | "unauthorized" | "target_mismatch";
} {
  let request: { action?: unknown; token?: unknown; targetId?: unknown };
  try {
    request = JSON.parse(raw) as typeof request;
  } catch {
    return { ok: false, error: "invalid_request" };
  }
  if (request.token !== token) return { ok: false, error: "unauthorized" };
  if (request.targetId !== targetId) return { ok: false, error: "target_mismatch" };
  if (request.action !== "cancel") return { ok: false, error: "invalid_request" };
  return { ok: true };
}

function closeJob(): void {
  if (jobClosed) return;
  jobClosed = true;
  job.close();
}

function waitForWorker(workerProcess: ChildProcessWithoutNullStreams): Promise<{
  pid: number;
  descendantPid: number;
  port: number;
}> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for worker readiness. stderr=${stderr}`));
    }, 20_000);
    workerProcess.stdout.setEncoding("utf8");
    workerProcess.stderr.setEncoding("utf8");
    workerProcess.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      clearTimeout(timer);
      const ready = JSON.parse(stdout.slice(0, lineEnd)) as {
        type?: string;
        pid?: number;
        descendantPid?: number;
        port?: number;
      };
      if (
        ready.type !== "worker-ready" ||
        !ready.pid ||
        !ready.descendantPid ||
        !ready.port
      ) {
        reject(new Error("Invalid worker readiness payload."));
        return;
      }
      resolvePromise({
        pid: ready.pid,
        descendantPid: ready.descendantPid,
        port: ready.port,
      });
    });
    workerProcess.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    workerProcess.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker exited before readiness with code ${code}. stderr=${stderr}`));
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
