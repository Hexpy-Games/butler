import { useAppLocale } from "@/app/copy.ts";
import { memo } from "react";
import {
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerSendButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils";
import { agentNoticeLabel } from "@/app/agentRuntime.ts";
import { AccessModeMenu } from "./AccessModeMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerContextControl } from "./ComposerContextControl";
import { ModelMenu } from "./ModelMenu";
import { ComposerPlanModeBadge } from "./ComposerPlanModeBadge";
import { ComposerWorkspaceSelect, useComposerSecondaryControls } from "./ComposerWorkspaceSelect";
import { imageRefusalLabel } from "./composerImagePolicy";

export const ComposerToolbar = memo(function ComposerToolbar({ panelActive = false }: { panelActive?: boolean } = {}) {
  useAppLocale();
  const hasSecondary = useComposerSecondaryControls();
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const [blockedImage] = useComposerStore((store) => store.blockedAttachments).values();
  const onStop = useComposerStore((store) => store.onStop);
  const reconnecting = useButlerStore((store) => store.liveConnectionLost);
  const settings = useButlerStore((store) => store.settings);
  const agentNotice = useButlerStore((store) => store.agentNotice);

  return (
    <ComposerCardToolbar theme={appShellTheme(settings)} onNarrow={() => useComposerStore.getState().setContextPopoverOpen(false)} moreLabel={appCopy.common.more} leading={<>
      <ComposerAttachmentMenu />
      <AccessModeMenu />
    </>} secondary={hasSecondary ? <>
        <ComposerWorkspaceSelect />
        <ComposerPlanModeBadge />
        <ComposerCardToolbarSpacer />
        <ComposerContextControl />
    </> : undefined} trailing={agentNotice ? (
        <ComposerSendButton busy={agentNotice === "restarting"} disabled
          aria-label={agentNoticeLabel(agentNotice)} title={agentNoticeLabel(agentNotice)} />
      ) : reconnecting ? (
        <ComposerSendButton busy aria-label={appCopy.feedback.reconnectingShort}
          title={appCopy.feedback.reconnectingShort} />
      ) : (isSending || activeTurn) && canStop && (!canSend || panelActive) ? (
        <ComposerSendButton
          mode="stop"
          aria-label={appCopy.composer.stop}
          onClick={onStop}
        />
      ) : (
          <ComposerSendButton
            aria-label={appCopy.composer.send}
            disabled={!canSend || panelActive}
            disabledReason={panelActive ? appCopy.composer.messageComposer : blockedImage ? imageRefusalLabel(blockedImage) : undefined}
          />
      )}>
      <ModelMenu />
    </ComposerCardToolbar>
  );
});
