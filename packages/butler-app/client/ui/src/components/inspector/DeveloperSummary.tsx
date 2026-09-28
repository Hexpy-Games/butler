import { appCopy } from "@/app/copy.ts";
import { InspectorPanel, KeyValueRow } from "@/butler-ds";
import { Artifact, EmptyPanelLine } from "@/components/common/Display.tsx";
import { contextTooltip } from "@/app/utils.ts";
import type { SessionSummaryView, StatusPill } from "@/app/types.ts";

/** Gateway, Git, context and skills details, shown in developer mode. */
export function DeveloperSummary({
  status,
  summary,
}: {
  status: StatusPill;
  summary?: SessionSummaryView | null;
}) {
  const skillsUsed = summary?.skills_used ?? [];
  return (
    <>
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
    return appCopy.composer.workspaceLocal;
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
