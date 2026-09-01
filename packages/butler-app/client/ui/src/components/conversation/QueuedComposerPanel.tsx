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
  const queued = messages.filter((message) => message.state !== "failed");
  const failed = messages.filter((message) => message.state === "failed");

  return (
    <>
      {queued.length > 0 && (
        <MessageQueuePanel
          messages={queued}
          heading={appCopy.composer.queuedMessages}
          editLabel={appCopy.composer.editQueuedMessage}
          deleteLabel={appCopy.composer.deleteQueuedMessage}
          status={appCopy.composer.queuedMessageStatus}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
      {failed.length > 0 && (
        <MessageQueuePanel
          messages={failed}
          heading={appCopy.composer.failedMessages}
          editLabel={appCopy.composer.retryFailedMessage}
          deleteLabel={appCopy.composer.deleteFailedMessage}
          status={appCopy.composer.failedMessageStatus}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </>
  );
}

function MessageQueuePanel(props: {
  messages: QueuedMessageRecord[];
  heading: string;
  editLabel: string;
  deleteLabel: string;
  status: string;
  onEdit: (message: QueuedMessageRecord) => void;
  onDelete: (message: QueuedMessageRecord) => void;
}) {
  const byId = new Map(props.messages.map((message) => [message.id, message]));
  return (
    <ComposerQueuePanel
      ariaLabel={props.heading}
      data-test-class="queued-composer-panel"
      heading={props.heading}
      editLabel={props.editLabel}
      deleteLabel={props.deleteLabel}
      items={props.messages.map((message) => queuedItem(message, props.status))}
      onEdit={(id) => {
        const message = byId.get(id);
        if (message) props.onEdit(message);
      }}
      onDelete={(id) => {
        const message = byId.get(id);
        if (message) props.onDelete(message);
      }}
    />
  );
}

function queuedItem(
  message: QueuedMessageRecord,
  status: string,
): ComposerQueuePanelItem {
  const label = message.text || attachmentFallback(message);
  return {
    id: message.id,
    label,
    ariaLabel: label,
    badge: queuedMeta(message, status),
  };
}

function queuedMeta(message: QueuedMessageRecord, status: string): string {
  if (message.state === "failed") return status;
  return message.attachments && message.attachments.length > 0
    ? appCopy.composer.queuedAttachmentCount(message.attachments.length)
    : status;
}

function attachmentFallback(message: QueuedMessageRecord): string {
  return message.attachments?.[0]?.safe_name ?? appCopy.composer.queuedMessage;
}
