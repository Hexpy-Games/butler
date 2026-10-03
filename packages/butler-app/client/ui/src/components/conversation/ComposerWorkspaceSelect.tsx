import { ComposerSelectControl, Select, SelectContent, SelectItem, SelectValue, Monitor, GitBranch } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { selectIsGitProject, useButlerStore } from "@/app/store.ts";
import { parseDraftChatId } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore.ts";

/** The project a new-chat draft belongs to (project draft or dashboard composer). */
function draftProjectId(draftId: string): string | undefined {
  if (draftId.startsWith("dashboard:")) return draftId.slice("dashboard:".length) || undefined;
  return parseDraftChatId(draftId).projectId;
}

export function useComposerWorkspaceEnabled() {
  const draftId = useComposerStore((state) => state.draftSessionId);
  return useButlerStore(selectIsGitProject(draftProjectId(draftId)));
}

export function useComposerSecondaryControls() {
  const workspace = useComposerWorkspaceEnabled();
  const otherControls = useComposerStore((state) => Boolean(state.planMode || state.context));
  return workspace || otherControls;
}

export function ComposerWorkspaceSelect() {
  useAppLocale();
  const mode = useComposerStore((state) => state.workspaceMode);
  const setMode = useComposerStore((state) => state.setWorkspaceMode);
  const isSending = useComposerStore((state) => state.isSending);
  // A worktree needs Git, so the choice exists only for new chats in a Git project.
  const gitProject = useComposerWorkspaceEnabled();
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
