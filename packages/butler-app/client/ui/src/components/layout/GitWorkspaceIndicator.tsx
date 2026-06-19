import type { ReactNode } from "react";
import type { GitWorkspaceView } from "@/app/types.ts";
import styles from "./GitWorkspaceIndicator.module.css";

export interface GitWorkspaceIndicatorModel {
  label: string;
  title: string;
  tone: "default" | "muted" | "warning";
}

export function GitWorkspaceInlineMeta({
  children,
  gitWorkspace,
}: {
  children: ReactNode;
  gitWorkspace?: GitWorkspaceView;
}) {
  const indicator = gitWorkspaceIndicatorModel(gitWorkspace) ? (
    <GitWorkspaceIndicator gitWorkspace={gitWorkspace} />
  ) : null;

  if (!indicator) {
    return <>{children}</>;
  }

  return (
    <span className={styles.inlineMeta}>
      <span>{children}</span>
      {indicator}
    </span>
  );
}

function shortSha(sha?: string): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

function branchLabel(gitWorkspace: GitWorkspaceView): string {
  if (gitWorkspace.detached) {
    return shortSha(gitWorkspace.headSha) ?? "detached";
  }
  return gitWorkspace.branch?.trim() || "unknown";
}

function modeLabel(gitWorkspace: GitWorkspaceView): string {
  if (!gitWorkspace.available) {
    return gitWorkspace.workspaceMode === "unknown" ? "unknown" : "non-git";
  }
  if (gitWorkspace.isLinkedWorktree || gitWorkspace.workspaceMode === "git-worktree") {
    return "worktree";
  }
  if (gitWorkspace.workspaceMode === "git-subdirectory") {
    return "subdir";
  }
  if (gitWorkspace.workspaceMode === "git-repository") {
    return "repo";
  }
  if (gitWorkspace.workspaceMode === "folder") {
    return "non-git";
  }
  return gitWorkspace.workspaceMode === "unknown" ? "unknown" : gitWorkspace.workspaceMode;
}

export function gitWorkspaceIndicatorModel(gitWorkspace?: GitWorkspaceView): GitWorkspaceIndicatorModel | null {
  if (!gitWorkspace) {
    return null;
  }

  const mode = modeLabel(gitWorkspace);
  const dirtySuffix = gitWorkspace.dirty ? "*" : "";
  const dirtyText = gitWorkspace.dirty ? ", dirty" : "";

  if (!gitWorkspace.available) {
    return {
      label: mode,
      title: `Git workspace: ${mode}`,
      tone: mode === "unknown" ? "warning" : "muted",
    };
  }

  const ref = branchLabel(gitWorkspace);
  const detachedText = gitWorkspace.detached ? "detached " : "";
  const worktreeText = mode === "worktree" ? " worktree" : mode === "subdir" ? " subdir" : "";

  return {
    label: `${ref}${dirtySuffix}${worktreeText}`,
    title: `Git workspace: ${detachedText}${ref} (${mode}${dirtyText})`,
    tone: gitWorkspace.dirty || gitWorkspace.detached ? "warning" : "default",
  };
}

export function GitWorkspaceIndicator({ gitWorkspace }: { gitWorkspace?: GitWorkspaceView }) {
  const model = gitWorkspaceIndicatorModel(gitWorkspace);
  if (!model) {
    return null;
  }

  return (
    <span
      className={`${styles.indicator} ${styles[model.tone]}`}
      data-testid="git-workspace-indicator"
      title={model.title}
    >
      {model.label}
    </span>
  );
}
