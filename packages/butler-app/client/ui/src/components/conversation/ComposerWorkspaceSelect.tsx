import { ComposerSelectControl, Select, SelectContent, SelectItem, SelectValue, Monitor, GitBranch } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { isDraftChatId, parseDraftChatId } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore.ts";

export function ComposerWorkspaceSelect() {
  useAppLocale();
  const draftId = useComposerStore((state) => state.draftSessionId);
  const mode = useComposerStore((state) => state.workspaceMode);
  const setMode = useComposerStore((state) => state.setWorkspaceMode);
  const isSending = useComposerStore((state) => state.isSending);
  const dashboard = draftId.startsWith("dashboard:");
  if (!dashboard && !isDraftChatId(draftId)) return null;
  const project = dashboard || parseDraftChatId(draftId).kind === "project";
  const copy = appCopy.composer;
  // Rendered in the composer toolbar so it stays on the composer surface.
  return (
    <Select value={project ? mode : "local"} disabled={isSending}
      onValueChange={(value) => setMode(value === "worktree" ? "worktree" : "local")}>
      <ComposerSelectControl aria-label={copy.workspace} data-test-class="composer-workspace-select"
        icon={project && mode === "worktree" ? <GitBranch size="sm" /> : <Monitor size="sm" />}>
        <SelectValue>{project && mode === "worktree" ? copy.workspaceWorktree : copy.workspaceLocal}</SelectValue>
      </ComposerSelectControl>
      <SelectContent position="popper" side="top">
        <SelectItem value="local">{copy.workspaceLocal}</SelectItem>
        <SelectItem value="worktree" disabled={!project}>{copy.workspaceWorktree}</SelectItem>
      </SelectContent>
    </Select>
  );
}
