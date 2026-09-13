import { useId } from "react";
import { NativeSelect, NativeSelectOption, Stack, TintedGlass, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { isDraftChatId, parseDraftChatId } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore.ts";

export function ComposerWorkspaceSelect() {
  useAppLocale();
  const descriptionId = useId();
  const draftId = useComposerStore((state) => state.draftSessionId);
  const mode = useComposerStore((state) => state.workspaceMode);
  const setMode = useComposerStore((state) => state.setWorkspaceMode);
  const isSending = useComposerStore((state) => state.isSending);
  const dashboard = draftId.startsWith("dashboard:");
  if (!dashboard && !isDraftChatId(draftId)) return null;
  const project = dashboard || parseDraftChatId(draftId).kind === "project";
  const copy = appCopy.composer;
  return (
    <TintedGlass padding="sm" radius="control">
      <Stack align="row" gap="sm" cross="center" wrap>
        <Typo.Caption>{copy.workspace}</Typo.Caption>
        <NativeSelect
          size="sm"
          aria-label={copy.workspace}
          aria-describedby={descriptionId}
          value={project ? mode : "local"}
          disabled={isSending}
          onChange={(event) => setMode(event.currentTarget.value === "worktree" ? "worktree" : "local")}
        >
          <NativeSelectOption value="local">{copy.workspaceLocal}</NativeSelectOption>
          <NativeSelectOption value="worktree" disabled={!project}>{copy.workspaceWorktree}</NativeSelectOption>
        </NativeSelect>
        <Typo.Caption id={descriptionId}>
          {!project ? copy.workspaceProjectRequired : mode === "worktree"
            ? copy.workspaceWorktreeDescription : copy.workspaceLocalDescription}
        </Typo.Caption>
      </Stack>
    </TintedGlass>
  );
}
