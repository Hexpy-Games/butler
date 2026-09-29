import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardExpandedControls, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { IconButton } from "../../../IconButton";
import { Plus, ShieldQuestion } from "../../../Icons";
import type { MotionCopy } from "./motionCopy";
import type { Name } from "./MotionTurn";

/** The composer open with the typed request: permission, model, and Send. */
export function DraftComposer({ copy, t }: { copy: MotionCopy; t: Name }) {
  return (
    <ComposerCard>
      <ComposerCardExpandedBody>
        <ComposerCardEditor>
          <ComposerCardEditable><div data-m={t("sc-ed")}>{copy.ask}</div></ComposerCardEditable>
        </ComposerCardEditor>
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
        <ComposerCardExpandedControls>
          <ComposerControl aria-label={`${copy.permission}: ${copy.askFirst}`} compact="icon" icon={<ShieldQuestion size="sm" />} label={copy.askFirst} permissionTone="ask" />
          <ComposerCardToolbarSpacer />
          <ComposerControl detail={copy.effort} label={copy.model} />
          <ComposerSendButton aria-label={copy.send} />
        </ComposerCardExpandedControls>
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
