import { Button, Spinner, Stack, Tooltip, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { Instruction } from "./memoryTypes";
import { instructionDuration, instructionScope } from "./hooks/useInstructions";
export function InstructionRow({ item, deleting, locked, lockReason, onDelete }: {
  item: Instruction; deleting: boolean; locked: boolean; lockReason?: string; onDelete: () => void;
}) {
  const id = `instruction-text-${item.handle}`;
  const duration = instructionDuration(item);
  const meta = item.duration === "this chat" ? duration : [instructionScope(item), duration].filter(Boolean).join(" · ");
  return <Stack align="row" cross="start" gap="md" role="group" aria-labelledby={id} data-test-class="instruction-row">
    <Stack gap="none" grow minWidth="0">
      <Typo.Body as="div" id={id} wrap="pre" alignWith="control">{item.text}</Typo.Body>
      <Typo.Caption tone="secondary" wrap="anywhere">{meta}</Typo.Caption>
    </Stack>
    <Tooltip label={locked ? lockReason ?? appCopy.settings.memory.deleting : undefined}>
      <Button id={`instruction-delete-${item.handle}`} type="button" variant="outline" disabled={locked} aria-busy={deleting || undefined}
        aria-label={locked ? `${appCopy.common.delete}. ${lockReason ?? appCopy.settings.memory.deleting}` : undefined}
        aria-describedby={id} iconStart={deleting ? <Spinner size={14} /> : undefined}
        text={appCopy.common.delete} onClick={onDelete} />
    </Tooltip>
  </Stack>;
}
