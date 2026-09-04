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
import { ComposerPlanDecisionActions } from "./ComposerPlanDecisionActions";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";

export function ComposerToolbar({
  planDecision,
}: {
  planDecision?: ComposerPlanDecision;
}) {
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const onStop = useComposerStore((store) => store.onStop);

  return (
    <ComposerCardToolbar>
      <ComposerAttachmentMenu />
      <ComposerCompactPreview />
      <ComposerCardExpandedControls>
        <AccessModeMenu />
        <ComposerPlanModeBadge />
        {planDecision ? (
          <ComposerPlanDecisionActions decision={planDecision} />
        ) : null}
        <ComposerCardToolbarSpacer />
        <ComposerContextControl />
        <ModelMenu />
      </ComposerCardExpandedControls>
      {(isSending || activeTurn) && canStop && !canSend ? (
        <ComposerSendButton
          mode="stop"
          aria-label={appCopy.composer.stop}
          onClick={onStop}
        />
      ) : (
        <ComposerCardExpandedControls>
          <ComposerSendButton
            aria-label={appCopy.composer.send}
            disabled={
              planDecision ? !planDecision.canSubmitInstruction : !canSend
            }
          />
        </ComposerCardExpandedControls>
      )}
    </ComposerCardToolbar>
  );
}
