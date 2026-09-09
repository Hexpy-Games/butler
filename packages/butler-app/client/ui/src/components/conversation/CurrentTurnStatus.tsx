import { useAppLocale } from "@/app/copy.ts";
import { appCopy, getAppLocale, interfaceProgressLabel } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { RollingStatusLine } from "@/libs/design-system";
import { publicOperationTitle } from "../../../../../../butler-progress-projection/src/index.ts";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";
import { AssistantStatusLabel } from "./AssistantStatusLabel";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme";
import { Typo } from "@/butler-ds";
import { useElapsedTime } from "./hooks/useElapsedTime";

export function CurrentTurnStatus({
  operation,
  modelRoundWait,
  publicActivity,
  phaseLabel,
  startedAt,
  state,
}: {
  operation?: ProgressRow;
  modelRoundWait?: ProgressRow;
  publicActivity?: ProgressRow;
  phaseLabel?: string;
  startedAt?: string;
  state?: string;
}) {
  useAppLocale();
  const markTheme = useButlerMarkTheme();
  const elapsed = useElapsedTime(startedAt);
  const operationLabel = operation
    ? interfaceProgressLabel(operation) || publicOperationTitle(operation.safe_tool_name, getAppLocale())
    : undefined;
  const providerRecovery = publicActivity?.bridge_phase ===
    "operational_recovery" ? publicActivity : undefined;
  const waitingForApproval = state === "waiting_for_form";
  const fullLabel = waitingForApproval ? appCopy.interfaceStatus.approvalWaiting : operationLabel ?? (providerRecovery ? interfaceProgressLabel(providerRecovery) : undefined) ??
    (modelRoundWait ? interfaceProgressLabel(modelRoundWait) : undefined) ?? (publicActivity ? interfaceProgressLabel(publicActivity) : undefined) ??
    phaseLabel ??
    appCopy.interfaceStatus.generating;
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
          {waitingForApproval ? <Typo.Body as="p">{fullLabel}</Typo.Body> : operation ? (
            <CurrentPhaseActivity row={{ ...operation, safe_label: operationLabel! }} />
          ) : providerRecovery ? (
            <CurrentPhaseActivity row={providerRecovery} />
          ) : modelRoundWait ? (
            <CurrentModelRoundWaiting row={modelRoundWait} />
          ) : publicActivity ? (
            <CurrentPhaseActivity row={publicActivity} />
          ) : phaseLabel ? (
            <Typo.Body as="p" data-test-class="turn-phase-status-fallback">
              {phaseLabel}
            </Typo.Body>
          ) : (
            <Typo.Body
              as="p"
              data-test-class="turn-status-fallback"
            >
              {fullLabel}{elapsed ? ` · ${elapsed}` : ""}
            </Typo.Body>
          )}
        </div>
      </AssistantStatusLabel>
    </RollingStatusLine>
  );
}
