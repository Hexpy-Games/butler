import { ComposerCard, ComposerCardCompactPreview, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardExpandedControls, ComposerCardToolbar, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import type { MotionCopy } from "./motionCopy";

/** The composer folded between turns: + and the placeholder, with Stop while a turn runs. */
export function CompactComposer({ copy, running }: { copy: MotionCopy; running: boolean }) {
  return (
    <ComposerCard expanded={false} controls={<ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>

        {running
          ? <ComposerSendButton aria-label={copy.stop} mode="stop" />
          : <ComposerCardExpandedControls><ComposerSendButton aria-label={copy.send} /></ComposerCardExpandedControls>}
      </ComposerCardToolbar>}>
      <ComposerCardExpandedBody>
        <ComposerCardEditor><ComposerCardEditable><div /></ComposerCardEditable></ComposerCardEditor>
      </ComposerCardExpandedBody>
      <ComposerCardCompactPreview data-empty="true">{copy.placeholder}</ComposerCardCompactPreview>
    </ComposerCard>
  );
}
