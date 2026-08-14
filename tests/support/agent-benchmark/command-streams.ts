import type { ChildProcess } from "node:child_process";

interface OutputStreamState {
  closed?: boolean;
  destroyed?: boolean;
  readableEnded?: boolean;
  readableLength?: number;
}

/** A destroyed/closed stream is complete only after all readable bytes drain. */
export function outputStreamIsComplete(stream: OutputStreamState | null): boolean {
  if (!stream) return true;
  const readableLength = stream.readableLength ?? 0;
  return readableLength === 0 && (stream.readableEnded === true || stream.closed === true || stream.destroyed === true);
}

export function drainOutputStream(
  stream: (OutputStreamState & { read?: () => Buffer | string | null }) | null,
  appendChunk: (chunk: Buffer | string) => void,
): void {
  if (!stream?.read || (stream.readableLength ?? 0) <= 0) return;
  let chunk: Buffer | string | null;
  try {
    while ((chunk = stream.read()) !== null) appendChunk(chunk);
  } catch {
    // A stream can be destroyed between the state check and read. The caller
    // will settle as incomplete after the bounded post-exit grace period.
  }
}

/** Exit is usable without a close event only after both output pipes ended. */
export function canSettleAfterExit(
  exitObserved: boolean,
  stdoutClosed: boolean,
  stderrClosed: boolean,
): boolean {
  return exitObserved && stdoutClosed && stderrClosed;
}

/** Benchmark commands are non-interactive; EOF must be delivered immediately. */
export function closeChildStdin(child: ChildProcess): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.once("error", () => {
    // A child can close fd 0 before the parent ends its pipe. This is benign
    // for the non-interactive benchmark and must not become an unhandled error.
  });
  try {
    stdin.end();
  } catch {
    // The child may have exited between spawn and stdin shutdown.
  }
}
