import type { ProgressRow } from "@/app/types.ts";
import { RollingStatusLine } from "@/libs/design-system";
import { publicOperationTitle } from "../../../../../../butler-progress-projection/src/index.ts";
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
  const operationLabel = operation
    ? publicOperationTitle(operation.safe_tool_name)
    : undefined;
  const fullLabel = operationLabel ?? publicActivity?.safe_label;
  return (
    <RollingStatusLine
      aria-live="polite"
      data-test-class="turn-current-status-slot"
      title={fullLabel}
    >
      <div data-test-class="turn-current-status-content">
        {operation ? (
          <CurrentPhaseActivity row={{ ...operation, safe_label: operationLabel! }} />
        ) : modelRoundWait ? (
          <CurrentModelRoundWaiting row={modelRoundWait} />
        ) : publicActivity ? (
          <CurrentPhaseActivity row={publicActivity} />
        ) : null}
      </div>
    </RollingStatusLine>
  );
}
