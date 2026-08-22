import { GitBranch } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionSummaryView } from "@/app/types.ts";
import styles from "./TitlebarWorkspaceSubtitle.module.css";

interface TitlebarWorkspaceSubtitleProps {
  branchInfo?: SessionSummaryView["branch_info"];
  projectLabel?: string;
}

export function TitlebarWorkspaceSubtitle({
  branchInfo,
  projectLabel,
}: TitlebarWorkspaceSubtitleProps) {
  const branch = branchInfo?.branch_name?.trim() || undefined;
  const workspaceLabel = branchInfo?.workspace_binding === "session_worktree"
    ? appCopy.titlebar.sessionWorktree(branch)
    : branchInfo?.workspace_binding === "project"
      ? appCopy.titlebar.localWorkspace(branch)
      : undefined;
  return (
    <span
      className={styles.subtitleContent}
      data-test-class="titlebar-subtitle"
    >
      {projectLabel ? (
        <span className={styles.projectSubtitle}>{projectLabel}</span>
      ) : null}
      {workspaceLabel ? (
        <span
          aria-label={workspaceLabel}
          className={styles.worktree}
          data-test-class="titlebar-workspace"
          title={workspaceLabel}
        >
          <GitBranch size={12} aria-hidden="true" />
          <span className={styles.worktreeLabel}>{workspaceLabel}</span>
        </span>
      ) : null}
    </span>
  );
}
