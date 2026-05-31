#!/usr/bin/env bun
import { spawn } from "node:child_process";

type OutputMode = "silent" | "verbose" | "json";

type RunResult = {
  gate: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutLength: number;
  stderrLength: number;
  durationMs: number;
};

type JsonOutput = {
  gate: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdoutLength: number;
  stderrLength: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const TAIL_LINE_LIMIT = 20;
const TAIL_CHAR_LIMIT = 1000;
const CAPTURE_CHAR_LIMIT = 64_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function parseArgs(): { gate: string; mode: OutputMode; timeout: number } {
  const args = process.argv.slice(2);
  let gate = "";
  let mode: OutputMode = "silent";
  let timeout = DEFAULT_TIMEOUT_MS;

  for (const arg of args) {
    if (arg === "--verbose") {
      mode = "verbose";
    } else if (arg === "--json") {
      mode = "json";
    } else if (arg.startsWith("--timeout=")) {
      timeout = Number.parseInt(arg.slice(10), 10) * 1000;
    } else if (!arg.startsWith("--")) {
      gate = arg;
    }
  }

  if (!gate) {
    console.error("Usage: validate.ts <gate> [--verbose|--json] [--timeout=SECONDS]");
    console.error("Example: validate.ts check");
    console.error("         validate.ts test:unit --verbose");
    process.exit(1);
  }

  return { gate, mode, timeout };
}

function appendCaptured(current: string, chunk: Buffer, originalLength: number): { text: string; originalLength: number } {
  const next = chunk.toString();
  const combined = current + next;
  return {
    text: combined.length > CAPTURE_CHAR_LIMIT ? combined.slice(-CAPTURE_CHAR_LIMIT) : combined,
    originalLength: originalLength + next.length,
  };
}

function getTail(text: string, lineLimit: number, charLimit: number, originalLength = text.length): { tail: string; truncated: boolean } {
  const lines = text.split("\n");
  let tail: string[];
  let truncated = originalLength > text.length;

  if (lines.length > lineLimit) {
    tail = lines.slice(-lineLimit);
    truncated = true;
  } else {
    tail = lines;
  }

  let result = tail.join("\n");
  if (Array.from(result).length > charLimit) {
    result = Array.from(result).slice(-charLimit).join("");
    truncated = true;
  }

  return { tail: result, truncated };
}

async function runGate(gate: string, mode: OutputMode, timeout: number): Promise<RunResult> {
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let stdoutLength = 0;
  let stderrLength = 0;
  let exitCode = 0;
  let timedOut = false;
  let killHandle: ReturnType<typeof setTimeout> | undefined;

  const bunExecutable = process.env.BUTLER_BUN ?? "bun";
  const childEnv = mode === "verbose"
    ? { ...process.env, BUTLER_VALIDATE_VERBOSE: "1" }
    : process.env;
  const child = spawn(bunExecutable, ["run", gate], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: mode === "verbose" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killHandle = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, timeout);

  if (mode !== "verbose") {
    child.stdout?.on("data", (chunk) => {
      const captured = appendCaptured(stdout, chunk, stdoutLength);
      stdout = captured.text;
      stdoutLength = captured.originalLength;
    });

    child.stderr?.on("data", (chunk) => {
      const captured = appendCaptured(stderr, chunk, stderrLength);
      stderr = captured.text;
      stderrLength = captured.originalLength;
    });
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      resolve();
    };

    child.on("close", (code) => {
      exitCode = code ?? 1;
      finish();
    });

    child.on("error", (error) => {
      const captured = appendCaptured(stderr, Buffer.from(`\nProcess error: ${error.message}`), stderrLength);
      stderr = captured.text;
      stderrLength = captured.originalLength;
      exitCode = 1;
      finish();
    });
  });

  const durationMs = Date.now() - startTime;

  return {
    gate,
    exitCode,
    timedOut,
    stdout,
    stderr,
    stdoutLength,
    stderrLength,
    durationMs,
  };
}

function printFailure(result: RunResult): void {
  console.error(`Validation gate failed: ${result.gate}`);
  console.error(`Exit code: ${result.exitCode}`);
  console.error(`Timeout: ${result.timedOut ? "yes" : "no"}`);
  console.error(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);

  if (result.stdout) {
    const { tail, truncated } = getTail(result.stdout, TAIL_LINE_LIMIT, TAIL_CHAR_LIMIT, result.stdoutLength);
    console.error("\nStdout (tail):");
    if (truncated) console.error("[... output truncated ...]");
    console.error(tail);
  }

  if (result.stderr) {
    const { tail, truncated } = getTail(result.stderr, TAIL_LINE_LIMIT, TAIL_CHAR_LIMIT, result.stderrLength);
    console.error("\nStderr (tail):");
    if (truncated) console.error("[... output truncated ...]");
    console.error(tail);
  }
}

function printJsonOutput(result: RunResult): void {
  const stdoutTailData = getTail(result.stdout, TAIL_LINE_LIMIT, TAIL_CHAR_LIMIT, result.stdoutLength);
  const stderrTailData = getTail(result.stderr, TAIL_LINE_LIMIT, TAIL_CHAR_LIMIT, result.stderrLength);

  const output: JsonOutput = {
    gate: result.gate,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutLength: result.stdoutLength,
    stderrLength: result.stderrLength,
    stdoutTail: stdoutTailData.tail,
    stderrTail: stderrTailData.tail,
    stdoutTruncated: stdoutTailData.truncated,
    stderrTruncated: stderrTailData.truncated,
  };

  console.log(JSON.stringify(output, null, 2));
}

function printVerboseSuccess(result: RunResult): void {
  console.log(`✓ Validation gate passed: ${result.gate}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
}

// Main
const { gate, mode, timeout } = parseArgs();

const result = await runGate(gate, mode, timeout);

if (result.exitCode === 0) {
  // Success
  if (mode === "verbose") {
    printVerboseSuccess(result);
  } else if (mode === "json") {
    printJsonOutput(result);
  }
  // Silent mode: no output
  process.exit(0);
} else {
  // Failure
  if (mode === "json") {
    printJsonOutput(result);
  } else {
    printFailure(result);
  }
  process.exit(result.exitCode);
}
