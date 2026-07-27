import type { ProgressRow } from "@/app/types.ts";
import { RollingStatusLine } from "@/libs/design-system";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";

export function CurrentTurnStatus({
  operation,
  modelRoundWait,
  publicActivity,
}: {
  operation?: ProgressRow;
  modelRoundWait?: ProgressRow;
  publicActivity?: ProgressRow;
}) {
  const fullLabel = operation?.safe_label ?? publicActivity?.safe_label;
  return (
    <RollingStatusLine
      aria-live="polite"
      data-test-class="turn-current-status-slot"
      title={fullLabel}
    >
      <div data-test-class="turn-current-status-content">
        {operation ? (
          <CurrentPhaseActivity row={operation} />
        ) : modelRoundWait ? (
          <CurrentModelRoundWaiting row={modelRoundWait} />
        ) : publicActivity ? (
          <CurrentPhaseActivity row={publicActivity} />
        ) : null}
      </div>
    </RollingStatusLine>
  );
}
