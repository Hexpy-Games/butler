import { NativeSelect, NativeSelectOption, Monitor, GitBranch } from "@/butler-ds";
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
    <NativeSelect
      size="sm"
      shape="pill"
      icon={project && mode === "worktree" ? <GitBranch size={16} /> : <Monitor size={16} />}
      aria-label={copy.workspace}
      value={project ? mode : "local"}
      disabled={isSending}
      onChange={(event) => setMode(event.currentTarget.value === "worktree" ? "worktree" : "local")}
    >
      <NativeSelectOption value="local">{copy.workspaceLocal}</NativeSelectOption>
      <NativeSelectOption value="worktree" disabled={!project}>{copy.workspaceWorktree}</NativeSelectOption>
    </NativeSelect>
  );
}
