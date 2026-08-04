import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummaryView } from "@/app/types.ts";
import { GitDependencyNoticePresenter } from "./GitDependencyNoticePresenter";

export function GitDependencyNotice() {
  const gitMissing = useButlerStore(
    (state) => shouldShowGitDependencyNotice(state.summary),
  );
  if (!gitMissing) return null;

  return (
    <GitDependencyNoticePresenter
      actionLabel={appCopy.composer.gitInstallAction}
      message={appCopy.composer.gitMissingMessage}
      title={appCopy.composer.gitMissingTitle}
    />
  );
}

export function shouldShowGitDependencyNotice(
  summary: SessionSummaryView | null | undefined,
): boolean {
  return summary?.branch_info?.safe_error_code === "git_not_installed";
}
