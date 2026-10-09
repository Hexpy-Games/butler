import { Button, DisclosureRow, Spinner, Stack, Tooltip, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { Instruction } from "./memoryTypes";
import { instructionDuration, instructionScope } from "./hooks/useInstructions";
/** One compact disclosure card: first line collapsed, full text and Delete when open. */
export function InstructionRow({ item, open, onToggle, deleting, locked, lockReason, onDelete }: {
  item: Instruction; open: boolean; onToggle: () => void; deleting: boolean; locked: boolean; lockReason?: string; onDelete: () => void;
}) {
  const id = `instruction-text-${item.handle}`;
  const panelId = `instruction-panel-${item.handle}`;
  const duration = instructionDuration(item);
  const meta = item.duration === "this chat" ? duration : [instructionScope(item), duration].filter(Boolean).join(" · ");
  const firstLine = item.text.split("\n").find((line) => line.trim()) ?? item.text;
  return <DisclosureRow id={`instruction-${item.handle}`} data-test-class="instruction-row" title={firstLine} meta={meta}
    controlsId={panelId} open={open} onToggle={onToggle}>
    <Stack id={panelId} gap="sm" cross="start">
      <Typo.Body as="div" id={id} wrap="pre">{item.text}</Typo.Body>
      <Tooltip label={locked ? lockReason ?? appCopy.settings.memory.deleting : undefined}>
        <Button id={`instruction-delete-${item.handle}`} type="button" variant="outline" disabled={locked} aria-busy={deleting || undefined}
          aria-label={locked ? `${appCopy.common.delete}. ${lockReason ?? appCopy.settings.memory.deleting}` : undefined}
          aria-describedby={id} iconStart={deleting ? <Spinner size={14} /> : undefined}
          text={appCopy.common.delete} onClick={onDelete} />
      </Tooltip>
    </Stack>
  </DisclosureRow>;
}
