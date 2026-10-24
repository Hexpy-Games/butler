import type { ReactElement } from "react";
import { Button, SettingsActionField, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { formatFileSize } from "../conversation/conversationUtils";
import { MemoryFacts } from "./MemoryFacts";
import type { MemoryCard, MemoryReceipt } from "./memoryTypes";
/** 대화 기억's actions: free up space (with its progress and the memory facts) and reset. */
export function ChatMemoryBody({ card, receipt, cancel, free, reset }: {
  card?: MemoryCard; receipt?: MemoryReceipt; cancel: () => void; free: ReactElement; reset: ReactElement;
}) {
  const copy = appCopy.settings.memory;
  return <>
    <SettingsActionField settingId="memory-free-space" label={copy.storageLabel} description={copy.freeSpaceDescription} action={free}
      afterControl={receipt && <Stack align="row" cross="start" gap="md">
        <Typo.Body as="div" grow minWidth="0" alignWith="control" role="status">
          {receipt.phase === "preparing" ? copy.freeWaiting : copy.freeing(formatFileSize(receipt.bytes_reclaimed))}
        </Typo.Body>
        <Button type="button" variant="outline" text={appCopy.common.cancel} onClick={cancel} />
      </Stack>}
      meta={<MemoryFacts card={card} />} />
    <SettingsActionField settingId="memory-reset-chat" label={copy.resetChatLabel} description={copy.resetChatDescription} action={reset} />
  </>;
}
