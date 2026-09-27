import { useState } from "react";
import { Spinner } from "../Spinner";
import { SuccessCheck } from "../SuccessCheck";

export type LoadingIndicatorState = "loading" | "done";

export interface LoadingIndicatorProps {
  /** `loading`: the Spinner. `done`: the ringed success check. */
  state: LoadingIndicatorState;
  /** Pixel box size shared by both states (ICON_SIZE values); default 16. */
  size?: number;
  /** Accessible name while loading (role="status"); omit when visible text says it. */
  label?: string;
  /** Accessible name once done; omit when visible text says it. */
  doneLabel?: string;
}

/**
 * Spinner -> check in one icon slot. The check draws in only when this
 * indicator saw `loading` first, so rows that mount already done (history)
 * show a static check. The caller owns the state and how long `done` stays.
 */
export function LoadingIndicator({ state, size = 16, label, doneLabel }: LoadingIndicatorProps) {
  const [sawLoading, setSawLoading] = useState(state === "loading");
  if (state === "loading" && !sawLoading) setSawLoading(true);
  return state === "loading"
    ? <Spinner size={size} label={label} />
    : <SuccessCheck ring size={size} animate={sawLoading} label={doneLabel} />;
}
