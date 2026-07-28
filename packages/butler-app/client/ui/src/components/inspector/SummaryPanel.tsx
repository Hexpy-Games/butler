import type { ReactElement } from "react";
import {
  ActivityFeed,
  Button,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleX,
  FileText,
  InspectorPanel,
  KeyValueRow,
  LoaderCircle,
} from "@/butler-ds";
import { Artifact, EmptyPanelLine } from "@/components/common/Display.tsx";
import { contextTooltip } from "@/app/utils.ts";
import { semanticProgressRows } from "@/app/conversation-progress";
import type { SessionSummaryView, StatusPill } from "@/app/types.ts";
import { inspectorInset } from "./inspectorLayout.ts";

export function SummaryPanel({
  status,
  summary,
  onExportTranscript,
}: {
  status: StatusPill;
  summary?: SessionSummaryView | null;
  onExportTranscript: () => void;
}) {
  const progressRows = semanticProgressRows(
    summary?.latest_progress?.safe_progress_rows ?? [],
  );
  const skillsUsed = summary?.skills_used ?? [];
  return (
    <>
      <ActivityFeed
        data-test-class="summary-progress-panel"
        title="Progress"
        emptyLabel="No session progress yet"
        style={inspectorInset}
        items={progressRows.map((item, index) => ({
          id: `${item.id}:${index}`,
          icon: progressStateIcon(item.state),
          title: item.safe_label,
        }))}
      />
      <InspectorPanel title="Branch details">
        <KeyValueRow
          label="Gateway"
          value={status.label}
        />
        <KeyValueRow
          label="Branch"
          value={summary?.branch_info?.branch_name ??
            summary?.branch_info?.safe_status ??
            "Unavailable"}
        />
        <KeyValueRow
          label="Context"
          value={contextTooltip(summary?.context_details)}
        />
      </InspectorPanel>
      <InspectorPanel title="Skills">
        {skillsUsed.length > 0 ? (
          skillsUsed.map((skill) => <Artifact key={skill} label={skill} />)
        ) : (
          <EmptyPanelLine label="No app-visible skills" />
        )}
      </InspectorPanel>
      <InspectorPanel title="Export">
        <Button
          type="button"
          onClick={onExportTranscript}
          variant="outline"
          stretch
          iconStart={<FileText size={16} />}
          text="Export app-visible transcript"
        />
      </InspectorPanel>
    </>
  );
}

function progressStateTone(state?: string): string {
  if (state === "delivered" || state === "complete") return "complete";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (
    state &&
    [
      "accepted",
      "thinking",
      "streaming",
      "waiting_for_tool",
      "retrying",
    ].includes(state)
  )
    return "running";
  return "idle";
}

function progressStateIcon(state?: string): ReactElement {
  const tone = progressStateTone(state);
  if (tone === "complete") return <CheckCircle2 size={18} />;
  if (tone === "failed") return <CircleAlert size={18} />;
  if (tone === "cancelled") return <CircleX size={18} />;
  if (tone === "running") return <LoaderCircle size={18} />;
  return <Circle size={18} />;
}
