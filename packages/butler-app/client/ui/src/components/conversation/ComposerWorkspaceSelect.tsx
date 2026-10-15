import { ComposerSelectControl, Select, SelectContent, SelectItem, SelectValue, Monitor, GitBranch } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { selectIsGitProject, useButlerStore } from "@/app/store.ts";
import { draftSessionTarget } from "@/app/utils.ts";
import type { NavigationView } from "@/app/types.ts";
import { useComposerStore } from "./composerStore.ts";

/** The project a new-chat draft belongs to (project or project-group draft, dashboard composer). */
function draftProjectId(navigation: NavigationView, draftId: string): string | undefined {
  if (draftId.startsWith("dashboard:")) return draftId.slice("dashboard:".length) || undefined;
  return draftSessionTarget(navigation, draftId).projectId;
}

export function ComposerWorkspaceSelect() {
  useAppLocale();
  const draftId = useComposerStore((state) => state.draftSessionId);
  const mode = useComposerStore((state) => state.workspaceMode);
  const setMode = useComposerStore((state) => state.setWorkspaceMode);
  const isSending = useComposerStore((state) => state.isSending);
  // A worktree needs Git, so the choice exists only for new chats in a Git project.
  const projectId = useButlerStore((state) => draftProjectId(state.navigation, draftId));
  const gitProject = useButlerStore(selectIsGitProject(projectId));
  if (!gitProject) return null;
  const copy = appCopy.composer;
  // Rendered in the composer toolbar so it stays on the composer surface.
  return (
    <Select value={mode} disabled={isSending}
      onValueChange={(value) => setMode(value === "worktree" ? "worktree" : "local")}>
      <ComposerSelectControl aria-label={copy.workspace} data-test-class="composer-workspace-select"
        icon={mode === "worktree" ? <GitBranch size="sm" /> : <Monitor size="sm" />}>
        <SelectValue>{mode === "worktree" ? copy.workspaceWorktree : copy.workspaceLocal}</SelectValue>
      </ComposerSelectControl>
      <SelectContent position="popper" side="top">
        <SelectItem value="local">{copy.workspaceLocal}</SelectItem>
        <SelectItem value="worktree">{copy.workspaceWorktree}</SelectItem>
      </SelectContent>
    </Select>
  );
}
