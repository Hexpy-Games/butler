import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardPlaceholder, ComposerCardInlineAction, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import { Box } from "../../../Box";
import { Plus } from "../../../Icons";
import { type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** The composer (22), its send button a pill. */
export function Composer({ copy }: { copy: RadiusCopy }) {
  return (
    <span className={s.composer}>
      <ComposerCard controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>
          <Box grow aria-hidden="true" />
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={<ComposerSendButton aria-label={copy.send} mode="send" />}>
        <ComposerCardEditor>
            <ComposerCardEditable><div /></ComposerCardEditable>
            <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>
          </ComposerCardEditor>
      </ComposerCardInlineAction>

      </ComposerCard>
    </span>
  );
}
