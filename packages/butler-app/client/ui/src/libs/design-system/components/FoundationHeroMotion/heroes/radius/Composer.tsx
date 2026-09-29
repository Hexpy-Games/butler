import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import { type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** The composer (22), its send button a pill. */
export function Composer({ copy }: { copy: RadiusCopy }) {
  return (
    <span className={s.composer}>
      <ComposerCard>
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable><div /></ComposerCardEditable>
            <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label={copy.more}><Plus size="md" /></IconButton>
          <ComposerCardToolbarSpacer />
          <ComposerSendButton aria-label={copy.send} mode="send" />
        </ComposerCardToolbar>
      </ComposerCard>
    </span>
  );
}
