import { fileSource } from "@/outputs/fileAccess";
import { useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { GatewayError } from "../../../butler-protocol/src/client/index.ts";
import { AttachmentTiles, QueuedMessage, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import type { QueuedConversationItem } from "./queue";

export function QueuedMessageItem({ item, onEdit, refresh }: {
  item: QueuedConversationItem; onEdit(text: string): void; refresh(): Promise<void>;
}) {
  const appCopy = getAppCopy(useAppLocale());
  const copy = appCopy.composer;
  const mobileCopy = useMobileCopy();
  const [sending, setSending] = useState(false);
  const { client, access } = useConversation();
  const failed = item.record.state === "failed";
  const path = `/session-queue/${encodeURIComponent(item.record.id)}`;
  const remove = async () => {
    try { await client?.request(path, { method: "DELETE" }); }
    catch { showToast({ message: appCopy.interfaceFeedback.queueDeleteFailed, tone: "error" }); }
    finally { await refresh(); }
  };
  const edit = async () => {
    if (!client) return;
    try {
      await client.request(path, { method: "DELETE" });
      onEdit(item.record.text);
    } catch { showToast({ message: appCopy.interfaceFeedback.queueUpdateFailed, tone: "error" }); }
    finally { await refresh(); }
  };
  const sendNow = async () => {
    setSending(true);
    try { await client?.request(`${path}/send-now`, { body: {} }); }
    catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "queued_message_not_next") {
        showToast({ message: copy.sendNowFailed, tone: "error" });
      }
    } finally { setSending(false); await refresh(); }
  };
  const status = failed ? copy.failedMessageStatus
    : item.total > 1 ? copy.queuedPosition(item.position, item.total) : copy.queuedMessageStatus;
  return <QueuedMessage text={item.record.text} status={status} tone={failed ? "failed" : sending ? "sending" : "queued"}
    sendNowLabel={copy.sendNow} onSendNow={item.canSendNow ? sendNow : undefined}
    editLabel={failed ? copy.retryFailedMessage : copy.editQueuedMessage}
    onEdit={!item.record.attachments?.length && !item.record.content_parts?.parts.length ? edit : undefined}
    deleteLabel={failed ? copy.deleteFailedMessage : copy.deleteQueuedMessage} onDelete={remove}
    attachments={item.record.attachments?.length ? <AttachmentTiles layout="wrap" items={item.record.attachments.map(file => ({
      key: file.file_id, name: file.safe_name, kind: file.kind === "image" || file.mime_type.startsWith("image/") ? "image" : "file",
      image: access && (file.kind === "image" || file.mime_type.startsWith("image/"))
        ? fileSource(access, file.url) : undefined,
      extension: file.safe_name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || mobileCopy.chat.fileLabel,
      meta: file.size_bytes < 1024 * 1024 ? `${Math.round(file.size_bytes / 1024)} KB` : `${(file.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
    }))} uploadingLabel={mobileCopy.chat.uploading} failedLabel={mobileCopy.chat.uploadFailed} /> : null}
  />;
}
