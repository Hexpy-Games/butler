import { useAppLocale } from "@/app/copy.ts";
import { Skeleton, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ActivityReadModel } from "@/app/conversation-progress";
import { AssistantStatusLabel } from "./AssistantStatusLabel";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme";

const SESSION_STARTING_STATE = "session_starting";
const SKELETON_WIDTH = "min(420px, 100%)";

export function TurnActivityPending({
  markKey,
  readModels,
  state,
}: {
  markKey?: string;
  readModels: ActivityReadModel[];
  state?: string;
}) {
  useAppLocale();
  const markTheme = useButlerMarkTheme();
  const receipt = acknowledgedReceipt(readModels);
  const pendingLabel = receipt?.label.trim()
    ? receipt.label
    : pendingStateLabel(state);
  if (state === SESSION_STARTING_STATE && !receipt) {
    return (
      <Stack
        aria-label={pendingLabel}
        aria-live="polite"
        data-test-class="turn-activity-panel turn-activity-pending-skeleton"
        gap="sm"
        UNSAFE_style={{ width: SKELETON_WIDTH }}
      >
        <AssistantStatusLabel
          label={pendingLabel}
          markKey={markKey}
          markTheme={markTheme}
          state="active"
        >
          <Typo.Body
            as="p"
            data-test-class="turn-activity-pending"
            data-turn-state={state}
            tone="secondary"
            weight="regular"
          >
            {pendingLabel}
          </Typo.Body>
        </AssistantStatusLabel>
        <Skeleton lines={3} height="line" />
      </Stack>
    );
  }
  return (
    <AssistantStatusLabel
      label={pendingLabel}
      markKey={markKey}
      markTheme={markTheme}
      state="active"
    >
      <Typo.Body
        aria-live="polite"
        as="p"
        data-test-class="turn-activity-panel turn-activity-pending"
        data-turn-state={state ?? "unknown"}
        tone="secondary"
        weight="regular"
      >
        {pendingLabel}
      </Typo.Body>
    </AssistantStatusLabel>
  );
}

function pendingStateLabel(state?: string): string {
  const normalizedState = state?.trim().toLowerCase();
  return normalizedState
    ? (appCopy.conversation.work.pendingStateLabels[normalizedState] ??
        appCopy.conversation.work.pendingLabel)
    : appCopy.conversation.work.pendingLabel;
}

function acknowledgedReceipt(
  readModels: ActivityReadModel[],
): Extract<ActivityReadModel, { type: "receipt" }> | undefined {
  return readModels.find(
    (model): model is Extract<ActivityReadModel, { type: "receipt" }> =>
      model.type === "receipt" && model.receiptKind === "turn.acknowledged",
  );
}
