import type { ProgressRow } from "@/app/types.ts";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";

const stableStatusSlot = {
  alignItems: "center",
  display: "flex",
  minHeight: "calc(var(--font-size-3) * var(--line-height-body))",
} as const;

export function CurrentTurnStatus({
  operation,
  modelRoundWait,
  publicActivity,
}: {
  operation?: ProgressRow;
  modelRoundWait?: ProgressRow;
  publicActivity?: ProgressRow;
}) {
  return (
    <div
      aria-live="polite"
      data-test-class="turn-current-status-slot"
      style={stableStatusSlot}
    >
      {operation ? (
        <CurrentPhaseActivity row={operation} />
      ) : modelRoundWait ? (
        <CurrentModelRoundWaiting row={modelRoundWait} />
      ) : publicActivity ? (
        <CurrentPhaseActivity row={publicActivity} />
      ) : null}
    </div>
  );
}
