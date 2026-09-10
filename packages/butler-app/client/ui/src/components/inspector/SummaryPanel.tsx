import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ReactElement } from "react";
import {
  ActivityFeed,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleX,
  InspectorPanel,
  KeyValueRow,
  Spinner,
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
  useAppLocale();
  const progressRows = summaryProgressRows(
    summary?.latest_progress?.safe_progress_rows ?? [],
  );
  const skillsUsed = summary?.skills_used ?? [];
  return (
    <>
      <ActivityFeed
        data-test-class="summary-progress-panel"
        title={appCopy.interfacePanels.progress}
        emptyLabel={appCopy.interfacePanels.noProgress}
        style={inspectorInset}
        items={progressRows.map((item, index) => ({
          id: `${item.id}:${index}`,
          icon: progressStateIcon(item.state),
          title: item.safe_label,
        }))}
      />
      <InspectorPanel title={appCopy.interfacePanels.branchDetails}>
        <KeyValueRow label={appCopy.interfacePanels.gateway} value={status.label} />
        <KeyValueRow
          label={appCopy.interfacePanels.gitBranch}
          value={branchValue(summary?.branch_info)}
        />
        <KeyValueRow
          label={appCopy.interfacePanels.workspace}
          value={workspaceValue(summary?.branch_info)}
        />
        <KeyValueRow
          label={appCopy.interfacePanels.changes}
          value={dirtyValue(summary?.branch_info)}
        />
        <KeyValueRow
          label={appCopy.interfacePanels.context}
          value={contextTooltip(summary?.context_details)}
        />
      </InspectorPanel>
      <InspectorPanel title={appCopy.interfacePanels.skills}>
        {skillsUsed.length > 0 ? (
          skillsUsed.map((skill) => <Artifact key={skill} label={skill} />)
        ) : (
          <EmptyPanelLine label={appCopy.interfacePanels.noVisibleSkills} />
        )}
      </InspectorPanel>
    </>
  );
}

function branchValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (!branch) return appCopy.interfacePanels.unavailable;
  if (branch.workspace_mode === "git") {
    return branch.branch_name?.trim() || appCopy.interfacePanels.detachedHead;
  }
  if (branch.workspace_mode === "folder") return appCopy.interfacePanels.notGit;
  if (branch.workspace_mode === "none") return appCopy.interfacePanels.noWorkspace;
  if (branch.safe_error_code === "git_not_installed") {
    return appCopy.interfacePanels.noGit;
  }
  return appCopy.interfacePanels.unavailable;
}

function workspaceValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (!branch) return appCopy.interfacePanels.unavailable;
  if (
    branch.workspace_binding === "session_worktree" &&
    branch.workspace_status === "unavailable"
  ) {
    return appCopy.interfacePanels.unavailableWorktree;
  }
  if (branch.workspace_binding === "session_worktree") {
    return appCopy.interfacePanels.worktree;
  }
  if (branch.workspace_binding === "project") {
    return appCopy.settings.options.local;
  }
  if (branch.workspace_mode === "none") return appCopy.interfacePanels.noWorkspace;
  if (branch.workspace_mode === "folder") return appCopy.interfacePanels.projectFolder;
  if (branch.workspace_mode === "git") return appCopy.interfacePanels.projectWorkspace;
  if (branch.safe_error_code === "git_not_installed") {
    return appCopy.interfacePanels.projectWorkspaceNoGit;
  }
  return appCopy.interfacePanels.unavailable;
}

function dirtyValue(
  branch: SessionSummaryView["branch_info"] | undefined,
): string {
  if (branch?.workspace_status === "unavailable") return appCopy.interfacePanels.unavailable;
  if (branch?.dirty === true) return appCopy.interfacePanels.dirty;
  if (branch?.dirty === false) return appCopy.interfacePanels.clean;
  return appCopy.interfacePanels.unavailable;
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
  if (tone === "running") return <Spinner size={18} />;
  return <Circle size={18} />;
}
