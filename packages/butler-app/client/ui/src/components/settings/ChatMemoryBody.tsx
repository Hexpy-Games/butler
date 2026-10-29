import type { ReactElement } from "react";
import { Button, ButtonContainer, SettingsActionField, SurfacePanel, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { formatFileSize } from "../conversation/conversationUtils";
import { MemoryFacts } from "./MemoryFacts";
import type { MemoryCard, MemoryReceipt } from "./memoryTypes";

export function ChatMemoryBody({ card, receipt, cancel, free, reset }: {
  card?: MemoryCard; receipt?: MemoryReceipt; cancel: () => void; free: ReactElement; reset: ReactElement;
}) {
  const copy = appCopy.settings.memory;
  return <>
    <SettingsActionField settingId="free-space" label={copy.storageLabel} description={copy.freeSpaceDescription}
      details={<SurfacePanel elevation="subtle"><MemoryFacts card={card} /></SurfacePanel>}
      action={<ButtonContainer size="sm">{free}{receipt && <Button type="button" size="sm" variant="outline" text={appCopy.common.cancel} onClick={cancel} />}</ButtonContainer>}
      meta={receipt && <Typo.Caption role="status" tone="secondary">
        {receipt.phase === "preparing" ? copy.freeWaiting : copy.freeing(formatFileSize(receipt.bytes_reclaimed))}
      </Typo.Caption>} />
    <SettingsActionField settingId="reset-chat-memory" label={copy.resetChatLabel} description={copy.resetChatDescription} action={reset} />
  </>;
}
