import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SessionSummaryView } from "@/app/types.ts";
import { GitDependencyNoticePresenter } from "./GitDependencyNoticePresenter";

const GIT_DEPENDENCY_NOTICE_DISMISSED_KEY =
  "butler:git-dependency-notice:v1:dismissed";

export function GitDependencyNotice() {
  const gitMissing = useButlerStore(
    (state) => shouldShowGitDependencyNotice(state.summary),
  );
  const [dismissed, setDismissed] = useState(readDismissedNotice);
  if (!gitMissing || dismissed) return null;

  return (
    <GitDependencyNoticePresenter
      actionLabel={appCopy.composer.gitInstallAction}
      closeLabel={appCopy.composer.gitMissingDismiss}
      message={appCopy.composer.gitMissingMessage}
      onDismiss={() => {
        setDismissed(true);
        writeDismissedNotice();
      }}
      title={appCopy.composer.gitMissingTitle}
    />
  );
}

function readDismissedNotice(): boolean {
  try {
    return (
      window.sessionStorage.getItem(GIT_DEPENDENCY_NOTICE_DISMISSED_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function writeDismissedNotice(): void {
  try {
    window.sessionStorage.setItem(GIT_DEPENDENCY_NOTICE_DISMISSED_KEY, "1");
  } catch {
    // The notice remains dismissible for this mounted renderer when storage is unavailable.
  }
}

export function shouldShowGitDependencyNotice(
  summary: SessionSummaryView | null | undefined,
): boolean {
  return summary?.branch_info?.safe_error_code === "git_not_installed";
}
