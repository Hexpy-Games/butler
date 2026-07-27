import type {
  OperationalRecoveryBoundary,
  OperationalRecoveryReadiness,
  OperationalRecoveryStore,
} from "./contracts.ts";

const MAX_PROVIDER_COOLDOWN_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function createOperationalRecoveryBoundary(
  store: OperationalRecoveryStore,
  readiness: OperationalRecoveryReadiness = createProviderRecoveryReadiness(),
): OperationalRecoveryBoundary {
  return {
    async awaitReentry(interruption, signal) {
      const receipt = await store.record(interruption);
      await readiness.wait({ interruption, receipt, signal });
      await store.markReady(receipt);
    },
    pending: (anchor) => store.pending(anchor),
    resolve: (anchor) => store.resolve(anchor),
    pendingTurnIds: () => store.pendingTurnIds(),
  };
}

export function createProviderRecoveryReadiness(): OperationalRecoveryReadiness {
  return {
    async wait({ interruption, receipt, signal }) {
      if (interruption.activation.kind === "automatic_provider_recovery") {
        const retryAt = interruption.activation.retryAt;
        if (retryAt) {
          await waitForDelay(providerReadinessDelay(retryAt), signal);
        } else {
          await waitForDelay(providerCooldown(receipt.activationCount), signal);
        }
        return;
      }
      if (interruption.activation.kind === "automatic_storage_recovery") {
        throw new Error("Operational storage recovery readiness is not configured");
      }
      await waitForActivation(signal);
    },
  };
}

function providerCooldown(activationCount: number): number {
  const exponent = Math.max(0, Math.min(activationCount - 1, 5));
  return Math.min(1_000 * (2 ** exponent), MAX_PROVIDER_COOLDOWN_MS);
}

function providerReadinessDelay(retryAt: string): number {
  const readinessAt = Date.parse(retryAt);
  if (!Number.isFinite(readinessAt)) {
    throw new Error("Provider recovery readiness deadline is invalid");
  }
  return Math.max(0, readinessAt - Date.now());
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const scheduledDelay = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(done, scheduledDelay);
    signal.addEventListener("abort", stopped, { once: true });
    function done() {
      signal.removeEventListener("abort", stopped);
      if (delayMs > scheduledDelay) {
        waitForDelay(delayMs - scheduledDelay, signal).then(resolve, reject);
      } else {
        resolve();
      }
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
