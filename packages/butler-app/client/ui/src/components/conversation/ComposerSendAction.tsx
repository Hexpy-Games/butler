import { useAppLocale, appCopy } from "@/app/copy.ts";
import { memo } from "react";
import { ComposerSendButton } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import { useButlerStore } from "@/app/store.ts";
import { agentNoticeLabel } from "@/app/agentRuntime.ts";
import { imageRefusalLabel } from "./composerImagePolicy";

export const ComposerSendAction = memo(function ComposerSendAction() {
  useAppLocale();
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const [blockedImage] = useComposerStore((store) => store.blockedAttachments).values();
  const onStop = useComposerStore((store) => store.onStop);
  const reconnecting = useButlerStore((store) => store.liveConnectionLost);
  const agentNotice = useButlerStore((store) => store.agentNotice);

  return agentNotice ? (
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
    <ComposerSendButton
      aria-label={appCopy.composer.send}
      disabled={!canSend}
      disabledReason={blockedImage ? imageRefusalLabel(blockedImage) : undefined}
    />
  );
});
