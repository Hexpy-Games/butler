import { useAppLocale } from "@/app/copy.ts";
import { GitBranch, Typo } from "@/butler-ds";
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
  useAppLocale();
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
          <GitBranch size="xs" aria-hidden="true" />
          <Typo.Text truncate>{workspaceLabel}</Typo.Text>
        </span>
      ) : null}
    </span>
  );
}
