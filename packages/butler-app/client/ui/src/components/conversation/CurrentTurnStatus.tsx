import type { ProgressRow } from "@/app/types.ts";
import { RollingStatusLine } from "@/libs/design-system";
import { publicOperationTitle } from "../../../../../../butler-progress-projection/src/index.ts";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";
import { AssistantStatusLabel } from "./AssistantStatusLabel";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme";
import { Typo } from "@/butler-ds";

export function CurrentTurnStatus({
  operation,
  modelRoundWait,
  publicActivity,
}: {
  operation?: ProgressRow;
  modelRoundWait?: ProgressRow;
  publicActivity?: ProgressRow;
}) {
  const markTheme = useButlerMarkTheme();
  const operationLabel = operation
    ? operation.safe_label || publicOperationTitle(operation.safe_tool_name)
    : undefined;
  const providerRecovery = publicActivity?.bridge_phase ===
    "operational_recovery" ? publicActivity : undefined;
  const fullLabel = operationLabel ?? publicActivity?.safe_label ??
    "응답 생성 중";
  return (
    <RollingStatusLine
      aria-live="polite"
      data-test-class="turn-current-status-slot"
      title={fullLabel}
    >
      <AssistantStatusLabel
        label={fullLabel}
        markTheme={markTheme}
        state="active"
      >
        <div data-test-class="turn-current-status-content">
          {operation ? (
            <CurrentPhaseActivity row={{ ...operation, safe_label: operationLabel! }} />
          ) : providerRecovery ? (
            <CurrentPhaseActivity row={providerRecovery} />
          ) : modelRoundWait ? (
            <CurrentModelRoundWaiting row={modelRoundWait} />
          ) : publicActivity ? (
            <CurrentPhaseActivity row={publicActivity} />
          ) : (
            <Typo.Body
              as="p"
              data-test-class="turn-status-fallback"
            >
              {fullLabel}
            </Typo.Body>
          )}
        </div>
      </AssistantStatusLabel>
    </RollingStatusLine>
  );
}
