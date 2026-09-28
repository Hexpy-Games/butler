import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ReactElement } from "react";
import {
  ActivityFeed,
  Circle,
  CircleAlert,
  CircleX,
  ICON_SIZE,
  InspectorInset,
  LoadingIndicator,
} from "@/butler-ds";
import { summaryProgressRows } from "@/app/conversation-progress";
import { DeveloperSummary } from "./DeveloperSummary.tsx";
import type { SessionSummaryView, StatusPill } from "@/app/types.ts";

export function SummaryPanel({
  developerMode = false,
  status,
  summary,
}: {
  /** Shows gateway, Git, context and skills details. */
  developerMode?: boolean;
  status: StatusPill;
  summary?: SessionSummaryView | null;
}) {
  useAppLocale();
  const progressRows = summaryProgressRows(
    summary?.latest_progress?.safe_progress_rows ?? [],
  );
  return (
    <>
      <InspectorInset>
        <ActivityFeed
          data-test-class="summary-progress-panel"
          title={appCopy.interfacePanels.progress}
          emptyLabel={appCopy.interfacePanels.noProgress}
          items={progressRows.map((item, index) => ({
            id: `${item.id}:${index}`,
            icon: progressStateIcon(item.state),
            title: item.safe_label,
          }))}
        />
      </InspectorInset>
      {developerMode && <DeveloperSummary status={status} summary={summary} />}
    </>
  );
}

function progressStateTone(state?: string): string {
  if (state && ["delivered", "complete", "completed"].includes(state)) {
    return "complete";
  }
  if (state === "failed") return "failed";
  if (state && ["cancelled", "stopped"].includes(state)) return "cancelled";
  if (
    state &&
    [
      "accepted",
      "active",
      "thinking",
      "running",
      "streaming",
      "reviewing",
      "correction_required",
      "waiting_for_tool",
      "retrying",
    ].includes(state)
  )
    return "running";
  return "idle";
}

function progressStateIcon(state?: string): ReactElement {
  const tone = progressStateTone(state);
  // Running and complete share one LoadingIndicator, so running -> complete draws the check.
  if (tone === "complete") return <LoadingIndicator state="done" size={ICON_SIZE.lg} />;
  if (tone === "failed") return <CircleAlert size="lg" />;
  if (tone === "cancelled") return <CircleX size="lg" />;
  if (tone === "running") return <LoadingIndicator state="loading" size={ICON_SIZE.lg} />;
  return <Circle size="lg" />;
}
