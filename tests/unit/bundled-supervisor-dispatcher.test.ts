import { expect, test } from "bun:test";
import { startBundledSupervisorDispatcher } from "../../packages/butler-agent/src/gateways/app/application/runtime/bundled-supervisor-dispatcher.ts";

test("bundled supervisor waits for the NativeButlerMain dispatcher readiness proof", async () => {
  let publishReady!: () => void;
  let settle!: () => void;
  const observed = { signal: null as AbortSignal | null };
  let handleResolved = false;

  const starting = startBundledSupervisorDispatcher({
    run: ({ shutdownSignal, onReady }) => {
      observed.signal = shutdownSignal;
      publishReady = onReady;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
    onUnexpectedExit: () => {
      throw new Error("dispatcher must not exit unexpectedly");
    },
  });
  void starting.then(() => {
    handleResolved = true;
  });

  await Promise.resolve();
  expect(handleResolved).toBe(false);
  publishReady();
  const handle = await starting;
  expect(handleResolved).toBe(true);
  expect(observed.signal?.aborted).toBe(false);

  handle.requestStop();
  expect(observed.signal?.aborted).toBe(true);
  settle();
  await handle.waitForExit();
});

test("bundled supervisor fails startup when the dispatcher exits before readiness", async () => {
  await expect(startBundledSupervisorDispatcher({
    run: async () => undefined,
    onUnexpectedExit: () => {
      throw new Error("unexpected callback before readiness");
    },
  })).rejects.toThrow("dispatcher exited unexpectedly");
});

test("bundled supervisor reports a dispatcher failure after readiness", async () => {
  let fail!: (error: Error) => void;
  const report = { error: null as Error | null };
  const handle = await startBundledSupervisorDispatcher({
    run: ({ onReady }) => {
      onReady();
      return new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    },
    onUnexpectedExit: (error) => {
      report.error = error;
    },
  });

  fail(new Error("dispatcher failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(report.error?.message).toBe("dispatcher failed");
  handle.requestStop();
  await handle.waitForExit().catch(() => undefined);
});