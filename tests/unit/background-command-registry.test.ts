import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { CommandExecutor } from "../../packages/butler-agent/src/runtime/command/contracts.ts";
import {
  backgroundCommandControlPaths,
  cancelRegisteredBackgroundCommand,
  hasFreshBackgroundCommandHeartbeat,
  isRegisteredBackgroundCommandActive,
  registeredBackgroundCommandCount,
  requestBackgroundCommandCancellation,
  startRegisteredBackgroundCommand,
} from "../../packages/butler-agent/src/runtime/command/background-command-registry.ts";

test("registered background commands cancel through the platform-neutral signal", async () => {
  let settledCancelled = false;
  const executor: CommandExecutor = {
    async execute(request) {
      return await new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve({
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          cancelled: true,
          durationMs: 1,
          error: null,
        }), { once: true });
      });
    },
  };
  startRegisteredBackgroundCommand({
    id: "background-cancel-proof",
    executor,
    request: { plan: { steps: [{ executable: "fixture" }] } },
    onSettled: (result) => {
      settledCancelled = result.cancelled;
    },
  });

  expect(isRegisteredBackgroundCommandActive("background-cancel-proof")).toBe(true);
  expect(() => startRegisteredBackgroundCommand({
    id: "background-cancel-proof",
    executor,
    request: { plan: { steps: [{ executable: "duplicate" }] } },
  })).toThrow("background command is already active");
  expect(cancelRegisteredBackgroundCommand("background-cancel-proof")).toBe(true);
  await waitFor(() => !isRegisteredBackgroundCommandActive("background-cancel-proof"));
  expect(settledCancelled).toBe(true);
  expect(registeredBackgroundCommandCount()).toBe(0);
});

test("registered background command cancellation is idempotent for missing work", () => {
  expect(cancelRegisteredBackgroundCommand("missing-background-command")).toBe(false);
});

test("durable cancellation and heartbeat work across process boundaries", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-background-control-"));
  const id = "cross-process-control-proof";
  const taskDir = join(butlerData, "tasks", id);
  const control = backgroundCommandControlPaths(butlerData, id);
  let settledCancelled = false;
  const executor: CommandExecutor = {
    async execute(request) {
      return await new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve({
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          cancelled: true,
          durationMs: 1,
          error: null,
        }), { once: true });
      });
    },
  };
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
    startRegisteredBackgroundCommand({
      id,
      executor,
      control,
      request: { plan: { steps: [{ executable: "fixture" }] } },
      onSettled: (result) => {
        settledCancelled = result.cancelled;
      },
    });
    expect(hasFreshBackgroundCommandHeartbeat(butlerData, id)).toBe(true);
    writeFileSync(control.cancellationFile, "external cancellation request\n", "utf8");
    await waitFor(() => !isRegisteredBackgroundCommandActive(id));
    expect(settledCancelled).toBe(true);
    expect(hasFreshBackgroundCommandHeartbeat(butlerData, id)).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("durable cancellation requests are accepted without an in-process registry", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-background-request-"));
  const id = "external-owner-proof";
  const taskDir = join(butlerData, "tasks", id);
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
    expect(requestBackgroundCommandCancellation({ butlerData, id })).toBe(true);
    expect(existsSync(
      backgroundCommandControlPaths(butlerData, id).cancellationFile,
    )).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("background command did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
