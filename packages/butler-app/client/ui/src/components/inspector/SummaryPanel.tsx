import type { ReactElement } from "react";
import {
  ActivityFeed,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleX,
  InspectorPanel,
  KeyValueRow,
  LoaderCircle,
} from "@/butler-ds";
import { Artifact, EmptyPanelLine } from "@/components/common/Display.tsx";
import { contextTooltip } from "@/app/utils.ts";
import { summaryProgressRows } from "@/app/conversation-progress";
import type { SessionSummaryView, StatusPill } from "@/app/types.ts";
import { inspectorInset } from "./inspectorLayout.ts";

export function SummaryPanel({
  status,
  summary,
}: {
  status: StatusPill;
  summary?: SessionSummaryView | null;
}) {
  const progressRows = summaryProgressRows(
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
        <KeyValueRow label="Gateway" value={status.label} />
        <KeyValueRow
          label="Git branch"
          value={branchValue(summary?.branch_info)}
        />
        <KeyValueRow
          label="Workspace"
          value={workspaceValue(summary?.branch_info)}
        />
        <KeyValueRow
          label="Changes"
          value={dirtyValue(summary?.branch_info)}
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
    </>
  );
}

function branchValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (!branch) return "Unavailable";
  if (branch.workspace_mode === "git") {
    return branch.branch_name?.trim() || "Detached HEAD";
  }
  if (branch.workspace_mode === "folder") return "Not a Git workspace";
  if (branch.workspace_mode === "none") return "No project workspace";
  if (branch.safe_error_code === "git_not_installed") {
    return "Git is not installed";
  }
  return "Unavailable";
}

function workspaceValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (!branch) return "Unavailable";
  if (
    branch.workspace_binding === "session_worktree" &&
    branch.workspace_status === "unavailable"
  ) {
    return "Session worktree unavailable";
  }
  if (branch.workspace_binding === "session_worktree") {
    return `Linked worktree · ${branch.workspace_label?.trim() || "Session worktree"}`;
  }
  if (branch.workspace_binding === "project") {
    return `Project · ${branch.workspace_label?.trim() || "Project workspace"}`;
  }
  if (branch.workspace_mode === "none") return "No project workspace";
  if (branch.workspace_mode === "folder") return "Project folder";
  if (branch.workspace_mode === "git") return "Project workspace";
  if (branch.safe_error_code === "git_not_installed") {
    return "Project workspace (Git unavailable)";
  }
  return "Unavailable";
}

function dirtyValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (branch?.workspace_status === "unavailable") return "Unavailable";
  if (branch?.dirty === true) return "Dirty";
  if (branch?.dirty === false) return "Clean";
  return "Unavailable";
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
  if (tone === "complete") return <CheckCircle2 size={18} />;
  if (tone === "failed") return <CircleAlert size={18} />;
  if (tone === "cancelled") return <CircleX size={18} />;
  if (tone === "running") return <LoaderCircle size={18} />;
  return <Circle size={18} />;
}
