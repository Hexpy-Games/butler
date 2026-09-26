import { useAppLocale } from "@/app/copy.ts";
import { GitBranch, IconSlot, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionSummaryView } from "@/app/types.ts";

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
    <Stack as="span" inline align="row" cross="center" gap="sm" minWidth="0" data-test-class="titlebar-subtitle">
      {projectLabel ? (
        <Typo.Text grow minWidth="0" truncate>{projectLabel}</Typo.Text>
      ) : null}
      {workspaceLabel ? (
        <Stack
          as="span"
          inline
          align="row"
          cross="center"
          gap="xs"
          minWidth="0"
          aria-label={workspaceLabel}
          data-test-class="titlebar-workspace"
          title={workspaceLabel}
        >
          <IconSlot size="xs" tone="secondary">
            <GitBranch size="xs" aria-hidden="true" />
          </IconSlot>
          <Typo.Text tone="secondary" truncate>{workspaceLabel}</Typo.Text>
        </Stack>
      ) : null}
    </Stack>
  );
}
