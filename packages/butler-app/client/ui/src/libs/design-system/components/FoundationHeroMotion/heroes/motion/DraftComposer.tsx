import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardInlineAction, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import { Box } from "../../../Box";
import { Plus, ShieldQuestion } from "../../../Icons";
import type { MotionCopy } from "./motionCopy";
import type { Name } from "./MotionTurn";

/** The composer open with the typed request: permission, model, and Send. */
export function DraftComposer({ copy, t }: { copy: MotionCopy; t: Name }) {
  return (
    <ComposerCard controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>
        <ComposerControl surface="glass" size="lg" aria-label={`${copy.permission}: ${copy.askFirst}`} compact="icon" icon={<ShieldQuestion size="sm" />} label={copy.askFirst} permissionTone="ask" />
          <Box grow aria-hidden="true" />
          <ComposerControl surface="glass" size="lg" detail={copy.effort} label={copy.model} />
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={<ComposerSendButton aria-label={copy.send} />}>
        <ComposerCardEditor>
          <ComposerCardEditable><div data-m={t("sc-ed")}>{copy.ask}</div></ComposerCardEditable>
        </ComposerCardEditor>
      </ComposerCardInlineAction>
    </ComposerCard>
  );
}
