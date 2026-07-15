import type { CommandExecutor } from "./contracts.ts";

export interface CommandExecutorConformanceReport {
  stdout: true;
  stderr: true;
  exitCode: true;
  stdin: true;
  pipeline: true;
  cancellation: true;
  timeout: true;
  unicode: true;
  unicodeChunkBoundary: true;
  quoting: true;
  duration: true;
  forceTermination: true;
}

export async function runCommandExecutorConformance(
  executor: CommandExecutor,
  runtimeExecutable: string,
): Promise<CommandExecutorConformanceReport> {
  const stdout = await executor.execute({
    plan: processPlan(runtimeExecutable, "process.stdout.write('stdout-ok')"),
  });
  assert(stdout.stdout === "stdout-ok" && stdout.exitCode === 0, "stdout");

  const stderr = await executor.execute({
    plan: processPlan(runtimeExecutable, "process.stderr.write('stderr-ok')"),
  });
  assert(stderr.stderr === "stderr-ok" && stderr.exitCode === 0, "stderr");

  const exitCode = await executor.execute({
    plan: processPlan(runtimeExecutable, "process.exit(7)"),
  });
  assert(exitCode.exitCode === 7 && !exitCode.timedOut, "exit code");

  const stdin = await executor.execute({
    plan: plan(
      processStep(
        runtimeExecutable,
        "let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => process.stdout.write(value))",
      ),
    ),
    stdin: "stdin-ok",
  });
  assert(stdin.stdout === "stdin-ok" && stdin.exitCode === 0, "stdin");

  const pipeline = await executor.execute({
    plan: plan(
      processStep(runtimeExecutable, "process.stdout.write('pipeline-ok')"),
      processStep(
        runtimeExecutable,
        "let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => process.stdout.write(value.toUpperCase()))",
      ),
    ),
  });
  assert(pipeline.stdout === "PIPELINE-OK" && pipeline.exitCode === 0, "pipeline");

  const abortController = new AbortController();
  const cancellationPromise = executor.execute({
    plan: processPlan(runtimeExecutable, "setTimeout(() => {}, 1000)"),
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 25);
  const cancellation = await cancellationPromise;
  assert(cancellation.cancelled && cancellation.exitCode === null, "cancellation");

  const timeout = await executor.execute({
    plan: processPlan(runtimeExecutable, "setTimeout(() => {}, 1000)"),
    timeoutMs: 25,
  });
  assert(timeout.timedOut && timeout.exitCode === null, "timeout");

  const unicodeValue = "한글 path with spaces — 日本語";
  const unicode = await executor.execute({
    plan: plan({
      executable: runtimeExecutable,
      arguments: ["-e", "process.stdout.write(process.argv[1])", unicodeValue],
    }),
  });
  assert(unicode.stdout === unicodeValue && unicode.exitCode === 0, "unicode");

  const unicodeChunkBoundary = await executor.execute({
    plan: processPlan(
      runtimeExecutable,
      "const value=Buffer.from('한'); process.stdout.write(value.subarray(0, 1)); setTimeout(() => process.stdout.write(value.subarray(1)), 10)",
    ),
  });
  assert(
    unicodeChunkBoundary.stdout === "한" && unicodeChunkBoundary.exitCode === 0,
    "unicode chunk boundary",
  );

  const quotedArguments = [
    "space value",
    'double"quote',
    "single'quote",
    "dollar$()&pipe|",
    "back`tick",
  ];
  const quoting = await executor.execute({
    plan: plan({
      executable: runtimeExecutable,
      arguments: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ...quotedArguments,
      ],
    }),
  });
  assert(
    quoting.stdout === JSON.stringify(quotedArguments) && quoting.exitCode === 0,
    "quoting",
  );
  assert(
    Number.isFinite(quoting.durationMs) && quoting.durationMs >= 0,
    "duration",
  );

  const forceController = new AbortController();
  const forcePromise = executor.execute({
    plan: processPlan(
      runtimeExecutable,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ),
    signal: forceController.signal,
  });
  setTimeout(() => forceController.abort(), 25);
  const forceTermination = await forcePromise;
  assert(
    forceTermination.cancelled && forceTermination.exitCode === null,
    "force termination",
  );

  return {
    stdout: true,
    stderr: true,
    exitCode: true,
    stdin: true,
    pipeline: true,
    cancellation: true,
    timeout: true,
    unicode: true,
    unicodeChunkBoundary: true,
    quoting: true,
    duration: true,
    forceTermination: true,
  };
}

function processStep(runtimeExecutable: string, source: string) {
  return {
    executable: runtimeExecutable,
    arguments: ["-e", source],
  };
}

function processPlan(runtimeExecutable: string, source: string) {
  return plan(processStep(runtimeExecutable, source));
}

function plan(
  first: ReturnType<typeof processStep>,
  ...rest: ReturnType<typeof processStep>[]
) {
  return { steps: [first, ...rest] as const };
}

function assert(condition: boolean, fixture: string): asserts condition {
  if (!condition) throw new Error(`command executor conformance failed: ${fixture}`);
}
