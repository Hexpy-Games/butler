import { useAppLocale } from "@/app/copy.ts";
import {
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerCardExpandedControls,
  ComposerSendButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { useButlerStore } from "@/app/store.ts";
import { agentNoticeLabel } from "@/app/agentRuntime.ts";
import { AccessModeMenu } from "./AccessModeMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerContextControl } from "./ComposerContextControl";
import { ModelMenu } from "./ModelMenu";
import { ComposerCompactPreview } from "./ComposerCompactPreview";
import { ComposerPlanModeBadge } from "./ComposerPlanModeBadge";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect";
import { imageRefusalLabel } from "./composerImagePolicy";

export function ComposerToolbar() {
  useAppLocale();
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const [blockedImage] = useComposerStore((store) => store.blockedAttachments).values();
  const onStop = useComposerStore((store) => store.onStop);
  const reconnecting = useButlerStore((store) => store.liveConnectionLost);
  const agentNotice = useButlerStore((store) => store.agentNotice);

  return (
    <ComposerCardToolbar>
      <ComposerAttachmentMenu />
      <ComposerCompactPreview />
      <ComposerCardExpandedControls>
        <AccessModeMenu />
        <ComposerWorkspaceSelect />
        <ComposerPlanModeBadge />
        <ComposerCardToolbarSpacer />
        <ComposerContextControl />
        <ModelMenu />
      </ComposerCardExpandedControls>
      {agentNotice ? (
        <ComposerSendButton busy={agentNotice === "restarting"} disabled
          aria-label={agentNoticeLabel(agentNotice)} title={agentNoticeLabel(agentNotice)} />
      ) : reconnecting ? (
        <ComposerSendButton busy aria-label={appCopy.feedback.reconnectingShort}
          title={appCopy.feedback.reconnectingShort} />
      ) : (isSending || activeTurn) && canStop && !canSend ? (
        <ComposerSendButton
          mode="stop"
          aria-label={appCopy.composer.stop}
          onClick={onStop}
        />
      ) : (
        <ComposerCardExpandedControls>
          <ComposerSendButton
            aria-label={appCopy.composer.send}
            disabled={!canSend}
            disabledReason={blockedImage ? imageRefusalLabel(blockedImage) : undefined}
          />
        </ComposerCardExpandedControls>
      )}
    </ComposerCardToolbar>
  );
}
