import { Skeleton, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ActivityReadModel } from "@/app/conversation-progress";

const SESSION_STARTING_STATE = "session_starting";
const SKELETON_WIDTH = "min(420px, 100%)";
const SKELETON_LINE_HEIGHT = "0.75rem";
const SKELETON_LINE_WIDTHS = ["86%", "68%", "46%"] as const;

export function TurnActivityPending({
  readModels,
  state,
}: {
  readModels: ActivityReadModel[];
  state?: string;
}) {
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
        gap="2"
        style={{ width: SKELETON_WIDTH }}
      >
        <Typo.Body
          as="p"
          data-test-class="turn-activity-pending"
          data-turn-state={state}
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontWeight: "var(--font-weight-regular)",
          }}
        >
          {pendingLabel}
        </Typo.Body>
        {SKELETON_LINE_WIDTHS.map((width) => (
          <Skeleton
            key={width}
            style={{ height: SKELETON_LINE_HEIGHT, width }}
          />
        ))}
      </Stack>
    );
  }
  return (
    <Typo.Body
      aria-live="polite"
      as="p"
      data-test-class="turn-activity-panel turn-activity-pending"
      data-turn-state={state ?? "unknown"}
      style={{
        margin: 0,
        color: "var(--text-secondary)",
        fontWeight: "var(--font-weight-regular)",
      }}
    >
      {pendingLabel}
    </Typo.Body>
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
