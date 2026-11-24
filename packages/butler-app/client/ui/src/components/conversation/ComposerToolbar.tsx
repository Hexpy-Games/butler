import { useAppLocale } from "@/app/copy.ts";
import { memo } from "react";
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
import { useComputerConnections } from "@/app/computerEvents";
import { sessionFromNavigation } from "@/app/utils";
import { ComposerLocationSelect } from "./ComposerLocationSelect";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect";
import { imageRefusalLabel } from "./composerImagePolicy";

export const ComposerToolbar = memo(function ComposerToolbar() {
  useAppLocale();
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const [blockedImage] = useComposerStore((store) => store.blockedAttachments).values();
  const onStop = useComposerStore((store) => store.onStop);
  const reconnecting = useButlerStore((store) => store.liveConnectionLost);
  const agentNotice = useButlerStore((store) => store.agentNotice);
  const computerId = useButlerStore((store) => sessionFromNavigation(store.navigation, store.activeChatId)?.computer_id);
  const computerUnreachable = useComputerConnections((store) => computerId && store.states[computerId] === "unreachable");

  return (
    <ComposerCardToolbar>
      <ComposerAttachmentMenu />
      <ComposerCompactPreview />
      <ComposerCardExpandedControls>
        <AccessModeMenu />
        <ComposerWorkspaceSelect />
        <ComposerLocationSelect />
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
      ) : computerUnreachable ? (
        <ComposerSendButton disabled aria-label={appCopy.computers.status.disconnected}
          disabledReason={appCopy.computers.status.disconnected} />
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
});
