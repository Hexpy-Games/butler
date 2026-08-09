import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface CodexQuotaProcessRequest {
  executable: string;
  arguments: readonly string[];
  stdin: string;
  followUpStdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CodexQuotaProcessResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError: boolean;
}

export type CodexQuotaProcessRunner = (
  request: CodexQuotaProcessRequest,
) => Promise<CodexQuotaProcessResult>;

export async function runCodexQuotaProcess(
  request: CodexQuotaProcessRequest,
): Promise<CodexQuotaProcessResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stdoutBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let followUpSent = false;
    let pendingLine = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const child = (() => {
      try {
        return spawn(request.executable, [...request.arguments], {
          env: process.env,
          stdio: ["pipe", "pipe", "ignore"],
          shell: false,
          windowsHide: true,
        });
      } catch {
        return null;
      }
    })();
    if (!child) {
      resolve({
        stdout,
        exitCode: null,
        timedOut: false,
        outputLimitExceeded: false,
        spawnError: true,
      });
      return;
    }
    const stdoutStream = child.stdout;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stdinStream) {
      child.kill("SIGKILL");
      resolve({
        stdout,
        exitCode: null,
        timedOut: false,
        outputLimitExceeded: false,
        spawnError: true,
      });
      return;
    }
    const finish = (result: Omit<CodexQuotaProcessResult, "stdout">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (!stdinStream.destroyed) stdinStream.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const trailingText = stdoutDecoder.end();
      if (Buffer.byteLength(stdout + trailingText, "utf8") <= request.maxOutputBytes) {
        stdout += trailingText;
      }
      resolve({ ...result, stdout });
    };
    const terminate = (timeout: boolean) => {
      if (timeout) timedOut = true;
      child.kill("SIGTERM");
      if (forceTimer) return;
      forceTimer = setTimeout(() => finish({
        exitCode: null,
        timedOut,
        outputLimitExceeded,
        spawnError: false,
      }), 250);
      forceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      terminate(true);
    }, request.timeoutMs);
    timer.unref?.();
    child.once("error", () => finish({
      exitCode: null,
      timedOut,
      outputLimitExceeded,
      spawnError: true,
    }));
    stdoutStream.on("data", (chunk: Buffer | string) => {
      if (outputLimitExceeded) return;
      const chunkBytes = typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : chunk.byteLength;
      if (stdoutBytes + chunkBytes > request.maxOutputBytes) {
        outputLimitExceeded = true;
        terminate(false);
        return;
      }
      stdoutBytes += chunkBytes;
      const text = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      stdout += text;
      pendingLine += text;
      while (true) {
        const newline = pendingLine.indexOf("\n");
        if (newline < 0) break;
        const line = pendingLine.slice(0, newline).trim();
        pendingLine = pendingLine.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        const record = message as { id?: unknown; error?: unknown };
        if (record.id === 1 && record.error) {
          finish({
            exitCode: 0,
            timedOut,
            outputLimitExceeded,
            spawnError: false,
          });
          return;
        }
        if (record.id === 1 && !followUpSent && request.followUpStdin) {
          followUpSent = true;
          try {
            stdinStream.write(request.followUpStdin);
          } catch {
            finish({
              exitCode: null,
              timedOut,
              outputLimitExceeded,
              spawnError: true,
            });
          }
        } else if (record.id === 2) {
          finish({
            exitCode: 0,
            timedOut,
            outputLimitExceeded,
            spawnError: false,
          });
          return;
        }
      }
    });
    child.once("close", (exitCode) => finish({
      exitCode,
      timedOut,
      outputLimitExceeded,
      spawnError: false,
    }));
    stdinStream.once("error", () => finish({
      exitCode: null,
      timedOut,
      outputLimitExceeded,
      spawnError: true,
    }));
    try {
      stdinStream.write(request.stdin);
    } catch {
      finish({
        exitCode: null,
        timedOut,
        outputLimitExceeded,
        spawnError: true,
      });
    }
  });
}
