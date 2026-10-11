import type { SignInPhase } from "./useSignIn";

export type SignInScreenState = "waiting" | "connecting" | "commitFailed" | "cancelled" | "timedout" | "failed";

/** Connected results render the ready step; this is the sign-in screen's only state mapping. */
export function signInScreenState(phase: SignInPhase, commit: { pending: unknown; failed: boolean }): SignInScreenState {
  if (commit.pending) return commit.failed ? "commitFailed" : "connecting";
  if (phase === "cancelled" || phase === "timedout" || phase === "failed") return phase;
  return "waiting";
}
