import { appCopy } from "@/app/copy.ts";
import type { QueuedMessageRecord } from "@/app/types.ts";
import {
  ComposerQueuePanel,
  type ComposerQueuePanelItem,
} from "@/butler-ds";

interface QueuedComposerPanelProps {
  messages: QueuedMessageRecord[];
  onEdit: (message: QueuedMessageRecord) => void;
  onDelete: (message: QueuedMessageRecord) => void;
}

export function QueuedComposerPanel({
  messages,
  onEdit,
  onDelete,
}: QueuedComposerPanelProps) {
  if (messages.length === 0) return null;
  const byId = new Map(messages.map((message) => [message.id, message]));

  return (
    <ComposerQueuePanel
      ariaLabel={appCopy.composer.queuedMessages}
      data-test-class="queued-composer-panel"
      heading={appCopy.composer.queuedMessages}
      editLabel={appCopy.composer.editQueuedMessage}
      deleteLabel={appCopy.composer.deleteQueuedMessage}
      items={messages.map(queuedItem)}
      onEdit={(id) => {
        const message = byId.get(id);
        if (message) onEdit(message);
      }}
      onDelete={(id) => {
        const message = byId.get(id);
        if (message) onDelete(message);
      }}
    />
  );
}

function queuedItem(message: QueuedMessageRecord): ComposerQueuePanelItem {
  const label = message.text || attachmentFallback(message);
  return {
    id: message.id,
    label,
    ariaLabel: label,
    badge: queuedMeta(message),
  };
}

function queuedMeta(message: QueuedMessageRecord): string {
  return message.attachments && message.attachments.length > 0
    ? appCopy.composer.queuedAttachmentCount(message.attachments.length)
    : appCopy.composer.queuedMessageStatus;
}

function attachmentFallback(message: QueuedMessageRecord): string {
  return message.attachments?.[0]?.safe_name ?? appCopy.composer.queuedMessage;
}
