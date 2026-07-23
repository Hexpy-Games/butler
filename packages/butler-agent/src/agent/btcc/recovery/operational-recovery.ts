import type {
  OperationalRecoveryBoundary,
  OperationalRecoveryStore,
  ProviderRecoveryReadiness,
} from "./contracts.ts";

const MAX_PROVIDER_COOLDOWN_MS = 30_000;

export function createOperationalRecoveryBoundary(
  store: OperationalRecoveryStore,
  readiness: ProviderRecoveryReadiness = createProviderRecoveryReadiness(),
): OperationalRecoveryBoundary {
  return {
    async awaitReentry(interruption, signal) {
      const receipt = await store.record(interruption);
      await readiness.wait({ interruption, receipt, signal });
      await store.markReady(receipt);
    },
    async resume(anchor, signal) {
      const record = await store.pending(anchor);
      if (!record) return null;
      if (record.status === "interrupted") {
        const receipt = await store.record(record.interruption);
        await readiness.wait({
          interruption: record.interruption,
          receipt,
          signal,
        });
        await store.markReady(receipt);
      }
      return record.interruption;
    },
    resolve: (anchor) => store.resolve(anchor),
    pendingTurnIds: () => store.pendingTurnIds(),
  };
}

export function createProviderRecoveryReadiness(): ProviderRecoveryReadiness {
  return {
    async wait({ interruption, receipt, signal }) {
      if (
        interruption.activation.kind === "automatic_provider_recovery" ||
        interruption.activation.kind === "automatic_storage_recovery"
      ) {
        await waitForCooldown(providerCooldown(receipt.activationCount), signal);
        return;
      }
      await waitForActivation(signal);
    },
  };
}

function providerCooldown(activationCount: number): number {
  const exponent = Math.max(0, Math.min(activationCount - 1, 5));
  return Math.min(1_000 * (2 ** exponent), MAX_PROVIDER_COOLDOWN_MS);
}

function waitForCooldown(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", stopped, { once: true });
    function done() {
      signal.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped() {
      clearTimeout(timer);
      reject(aborted());
    }
  });
}

function waitForActivation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(aborted()), { once: true });
  });
}

function aborted(): Error {
  const error = new Error("BTCC operational recovery was stopped");
  error.name = "AbortError";
  return error;
}
