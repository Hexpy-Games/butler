import { Select, SelectPillTrigger, SelectContent, SelectItem, SelectValue, Stack, Monitor, GitBranch } from "@/butler-ds";
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
  return (
    <Stack align="row" justify="start" cross="center" gap="xs">
      <Select value={project ? mode : "local"} disabled={isSending}
        onValueChange={(value) => setMode(value === "worktree" ? "worktree" : "local")}>
        <SelectPillTrigger aria-label={copy.workspace}
          icon={project && mode === "worktree" ? <GitBranch size={14} /> : <Monitor size={14} />}>
          <SelectValue>{project && mode === "worktree" ? copy.workspaceWorktree : copy.workspaceLocal}</SelectValue>
        </SelectPillTrigger>
        <SelectContent position="popper" side="top">
          <SelectItem value="local">{copy.workspaceLocal}</SelectItem>
          <SelectItem value="worktree" disabled={!project}>{copy.workspaceWorktree}</SelectItem>
        </SelectContent>
      </Select>
    </Stack>
  );
}
