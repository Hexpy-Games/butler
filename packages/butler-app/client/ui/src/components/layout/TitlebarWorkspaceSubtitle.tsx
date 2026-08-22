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
  const branch = branchInfo?.workspace_binding === "session_worktree"
    ? branchInfo.branch_name?.trim() || branchInfo.workspace_label?.trim()
    : undefined;
  const worktreeLabel = branch
    ? appCopy.titlebar.sessionWorktree(branch)
    : undefined;
  return (
    <span
      className={styles.subtitleContent}
      data-test-class="titlebar-subtitle"
    >
      {projectLabel ? (
        <span className={styles.projectSubtitle}>{projectLabel}</span>
      ) : null}
      {worktreeLabel ? (
        <span
          aria-label={worktreeLabel}
          className={styles.worktree}
          data-test-class="titlebar-worktree"
          title={worktreeLabel}
        >
          <GitBranch size={12} aria-hidden="true" />
          <span className={styles.worktreeLabel}>{worktreeLabel}</span>
        </span>
      ) : null}
    </span>
  );
}
