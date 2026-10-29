import { ExpandableText, IconButton, Spinner, Stack, Trash2 } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { Instruction } from "./memoryTypes";
import { instructionDuration, instructionScope } from "./hooks/useInstructions";

/** The text grows in place while its delete action stays at the top. */
export function InstructionRow({ item, deleting, locked, lockReason, onDelete }: {
  item: Instruction; deleting: boolean; locked: boolean; lockReason?: string; onDelete: () => void;
}) {
  const id = `instruction-text-${item.handle}`;
  const duration = instructionDuration(item);
  const meta = item.scope.kind === "session" && item.duration === "this chat" ? duration
    : [instructionScope(item), item.duration === "always" ? "" : duration].filter(Boolean).join(" · ");
  const reason = lockReason ?? appCopy.settings.memory.deleting;
  return <Stack id={`instruction-${item.handle}`} data-test-class="instruction-row" align="row" cross="start" gap="md">
    <Stack.Item grow minWidth="0"><ExpandableText id={id} collapsedLines={1} meta={meta}>{item.text}</ExpandableText></Stack.Item>
    <IconButton id={`instruction-delete-${item.handle}`} label={locked ? `${appCopy.common.delete} · ${reason}` : appCopy.common.delete}
      disabled={locked} aria-busy={deleting || undefined} aria-describedby={id} onClick={onDelete}>
      {deleting ? <Spinner size={14} /> : <Trash2 size="md" />}
    </IconButton>
  </Stack>;
}
