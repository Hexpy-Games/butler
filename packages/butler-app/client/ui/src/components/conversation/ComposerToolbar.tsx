import {
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerCardExpandedControls,
  ComposerSendButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { AccessModeMenu } from "./AccessModeMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerContextControl } from "./ComposerContextControl";
import { ModelMenu } from "./ModelMenu";
import { ComposerCompactPreview } from "./ComposerCompactPreview";
import { ComposerPlanModeBadge } from "./ComposerPlanModeBadge";

export function ComposerToolbar({ decisionInput }: { decisionInput?: { canSend: boolean } } = {}) {
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const onStop = useComposerStore((store) => store.onStop);

  return (
    <ComposerCardToolbar>
      {!decisionInput ? <ComposerAttachmentMenu /> : null}
      <ComposerCompactPreview />
      <ComposerCardExpandedControls>
        <AccessModeMenu />
        <ComposerPlanModeBadge />
        <ComposerCardToolbarSpacer />
        <ComposerContextControl />
        <ModelMenu />
      </ComposerCardExpandedControls>
      {!decisionInput && (isSending || activeTurn) && canStop && !canSend ? (
        <ComposerSendButton
          mode="stop"
          aria-label={appCopy.composer.stop}
          onClick={onStop}
        />
      ) : (
        <ComposerCardExpandedControls>
          <ComposerSendButton
            aria-label={appCopy.composer.send}
            disabled={!(decisionInput?.canSend ?? canSend)}
          />
        </ComposerCardExpandedControls>
      )}
    </ComposerCardToolbar>
  );
}
