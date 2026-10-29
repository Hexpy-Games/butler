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
import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import { useElapsedTime } from "./hooks/useElapsedTime";

/** The running turn's status line; `activityLabel` (대화's current tool) replaces the step and model-wait labels. */
export function CurrentTurnStatus({
  markKey,
  thinkingLine,
  operation,
  modelRoundWait,
  publicActivity,
  phaseLabel,
  startedAt,
  state,
  waitingForAnswer = false,
  activityLabel,
}: {
  activityLabel?: string;
  markKey?: string;
  thinkingLine?: string;
  operation?: ProgressRow;
  modelRoundWait?: ProgressRow;
  publicActivity?: ProgressRow;
  phaseLabel?: string;
  startedAt?: string;
  state?: string;
  waitingForAnswer?: boolean;
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
  const waitingLabel = useWaitingLabel(waitingForAnswer);
  const activity = !waitingForApproval && !providerRecovery ? activityLabel : undefined;
  const summaryLine = !waitingForApproval && !operation && !providerRecovery && !activity && modelRoundWait ? thinkingLine : undefined;
  const fullLabel = waitingForApproval ? waitingLabel : activity ?? operationLabel ?? (providerRecovery ? interfaceProgressLabel(providerRecovery) : undefined) ??
    (modelRoundWait ? summaryLine ?? appCopy.interfaceStatus.generating : undefined) ?? (publicActivity ? interfaceProgressLabel(publicActivity) : undefined) ??
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
        markKey={markKey}
        markTheme={markTheme}
        state="active"
        shimmer={!summaryLine}
      >
        <div data-test-class="turn-current-status-content">
          {waitingForApproval ? <Typo.Body as="p">{fullLabel}</Typo.Body> : activity ? <ChatActivityText label={activity} elapsed={elapsed} /> : operation ? (
            <CurrentPhaseActivity row={{ ...operation, safe_label: operationLabel! }} />
          ) : providerRecovery ? (
            <CurrentPhaseActivity row={providerRecovery} />
          ) : modelRoundWait ? (
            <CurrentModelRoundWaiting row={modelRoundWait} line={summaryLine} />
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

function ChatActivityText({ label, elapsed }: { label: string; elapsed?: string }) {
  return (
    <Typo.Body as="p" tone="secondary" minWidth="0" data-test-class="turn-chat-activity">
      {label}{elapsed ? ` · ${elapsed}` : ""}
    </Typo.Body>
  );
}

/** What a waiting turn waits on: an answer, the user's step in a browser tab, or an approval. */
function useWaitingLabel(waitingForAnswer: boolean): string {
  // A browser hand-off waits on the user's step in the tab, not on an approval.
  const handoffTool = useButlerStore((store) => selectActiveAuthorityApprovals(store)[0]?.approval?.operation?.tool);
  return waitingForAnswer ? appCopy.interfaceStatus.answerWaiting
    : handoffTool === "browser_sign_in_wait" ? appCopy.interfaceStatus.signInWaiting
      : handoffTool === "browser_wait_for_user" || handoffTool === "browser_pay_wait" ? appCopy.interfaceStatus.tabWaiting : appCopy.interfaceStatus.approvalWaiting;
}
