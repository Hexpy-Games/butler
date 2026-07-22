export interface ContentionScanTrigger {
  wait(signal?: AbortSignal): Promise<void>;
}

export class TimerContentionScanTrigger implements ContentionScanTrigger {
  constructor(private readonly intervalMs = 50) {}

  wait(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(stopped());
      const timer = setTimeout(complete, this.intervalMs);
      const abort = () => {
        clearTimeout(timer);
        reject(stopped());
      };
      function complete() {
        signal?.removeEventListener("abort", abort);
        resolve();
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function stopped(): Error {
  return new Error("Ledger contention wait was stopped");
}
