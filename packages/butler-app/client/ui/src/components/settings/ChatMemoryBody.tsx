import { Button, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { formatFileSize } from "../conversation/conversationUtils";
import { MemoryFacts } from "./MemoryFacts";
import type { MemoryCard, MemoryReceipt } from "./memoryTypes";
export function ChatMemoryBody({ card, receipt, cancel }: { card?: MemoryCard; receipt?: MemoryReceipt; cancel: () => void }) {
  const copy = appCopy.settings.memory;
  return <Stack gap="md">
    <MemoryFacts card={card} />
    {receipt && <Stack align="row" cross="start" gap="md">
      <Typo.Body as="div" grow minWidth="0" alignWith="control" role="status">
        {receipt.phase === "preparing" ? copy.freeWaiting : copy.freeing(formatFileSize(receipt.bytes_reclaimed))}
      </Typo.Body>
      <Button type="button" variant="outline" text={appCopy.common.cancel} onClick={cancel} />
    </Stack>}
  </Stack>;
}
