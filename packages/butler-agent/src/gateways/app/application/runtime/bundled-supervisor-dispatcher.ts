export interface BundledSupervisorDispatcherRunOptions {
  shutdownSignal: AbortSignal;
  onReady: () => void;
}

export interface BundledSupervisorDispatcherHandle {
  requestStop: (reason?: unknown) => void;
  waitForExit: () => Promise<void>;
}

export async function startBundledSupervisorDispatcher(input: {
  run: (options: BundledSupervisorDispatcherRunOptions) => Promise<unknown>;
  onUnexpectedExit: (error: Error) => void;
}): Promise<BundledSupervisorDispatcherHandle> {
  const controller = new AbortController();
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const task = Promise.resolve().then(() =>
    input.run({
      shutdownSignal: controller.signal,
      onReady: () => {
        if (ready) return;
        ready = true;
        resolveReady();
      },
    }),
  );

  void task.then(
    () => {
      if (controller.signal.aborted) return;
      const error = new Error("bundled App dispatcher exited unexpectedly");
      if (!ready) rejectReady(error);
      else input.onUnexpectedExit(error);
    },
    (error: unknown) => {
      if (controller.signal.aborted) return;
      if (!ready) rejectReady(error);
      else {
        input.onUnexpectedExit(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  );

  await readyPromise;
  return {
    requestStop(reason = new Error("bundled App dispatcher stopping")) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    async waitForExit() {
      await task;
    },
  };
}