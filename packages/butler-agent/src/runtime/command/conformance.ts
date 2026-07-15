import type { CommandExecutor } from "./contracts.ts";

export interface CommandExecutorConformanceReport {
  stdout: true;
  stderr: true;
  exitCode: true;
  stdin: true;
  pipeline: true;
  cancellation: true;
  timeout: true;
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

  return {
    stdout: true,
    stderr: true,
    exitCode: true,
    stdin: true,
    pipeline: true,
    cancellation: true,
    timeout: true,
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
