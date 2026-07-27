import type { ProgressRow } from "@/app/types.ts";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";
import styles from "./CurrentTurnStatus.module.css";

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
    <div
      aria-live="polite"
      className={styles.slot}
      data-test-class="turn-current-status-slot"
      title={fullLabel}
    >
      <div className={styles.content} data-test-class="turn-current-status-content">
        {operation ? (
          <CurrentPhaseActivity row={operation} />
        ) : modelRoundWait ? (
          <CurrentModelRoundWaiting row={modelRoundWait} />
        ) : publicActivity ? (
          <CurrentPhaseActivity row={publicActivity} />
        ) : null}
      </div>
    </div>
  );
}
