import { appCopy } from "./copy";

/** Desktop-only full reset: main holds the admin credential, sends the request and relaunches the app. */
type BridgeResult = { ok: true } | { ok: false; error?: { code?: string } };

interface FullResetBridge {
  requestFullReset?: (input: { operationId: string }) => Promise<BridgeResult>;
  relaunchAfterFullReset?: () => Promise<BridgeResult>;
}

function bridge(): FullResetBridge | undefined {
  return typeof window === "undefined" ? undefined : window.butlerApp as FullResetBridge | undefined;
}

export function fullResetAvailable(): boolean {
  const target = bridge();
  return typeof target?.requestFullReset === "function" && typeof target.relaunchAfterFullReset === "function";
}

function settle(result: BridgeResult | undefined): void {
  if (result?.ok) return;
  throw Object.assign(new Error("full_reset_failed"), { code: result?.error?.code ?? "request_failed" });
}

/** Asks the agent to reset (the server checks its own fixed token), then restarts the app. */
export async function runFullReset(operationId: string): Promise<void> {
  settle(await bridge()?.requestFullReset?.({ operationId }));
  settle(await bridge()?.relaunchAfterFullReset?.());
}

let outcomeAnnounced = false;

/** A reset whose data move failed keeps the old data; say so once after the relaunch. */
export function announceFullResetOutcome(notify: (message: string) => void): void {
  const failed = typeof window !== "undefined" && (window.butlerApp as { fullResetFailed?: unknown } | undefined)?.fullResetFailed === true;
  if (!failed || outcomeAnnounced) return;
  outcomeAnnounced = true;
  notify(appCopy.settings.memory.resetFailed);
}
