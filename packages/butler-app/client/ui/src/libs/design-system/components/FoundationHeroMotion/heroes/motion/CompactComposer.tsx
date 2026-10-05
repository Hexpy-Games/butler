import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardPlaceholder, ComposerCardInlineAction, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import { Plus } from "../../../Icons";
import type { MotionCopy } from "./motionCopy";

/** Always-visible composer, with Stop while a turn runs. */
export function CompactComposer({ copy, running }: { copy: MotionCopy; running: boolean }) {
  return (
    <ComposerCard controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={running
          ? <ComposerSendButton aria-label={copy.stop} mode="stop" />
          : <ComposerSendButton aria-label={copy.send} />}>
        <ComposerCardEditor><ComposerCardEditable><div /></ComposerCardEditable><ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder></ComposerCardEditor>
      </ComposerCardInlineAction>
    </ComposerCard>
  );
}
