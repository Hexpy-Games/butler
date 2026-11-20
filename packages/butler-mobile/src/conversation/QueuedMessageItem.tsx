import { View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { GatewayError } from "../../../butler-protocol/src/client/index.ts";
import { IconButton, icons, showToast, Text, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { useConversation } from "./live";
import { UserMessage } from "./Message";
import type { QueuedConversationItem } from "./queue";

export function QueuedMessageItem({ item, onEdit, refresh }: {
  item: QueuedConversationItem; onEdit(text: string): void; refresh(): Promise<void>;
}) {
  const appCopy = getAppCopy(useAppLocale());
  const copy = appCopy.composer;
  const t = useTokens();
  const { client } = useConversation();
  const failed = item.record.state === "failed";
  const path = `/session-queue/${encodeURIComponent(item.record.id)}`;
  const remove = async () => {
    try { await client?.request(path, { method: "DELETE" }); }
    catch { showToast({ message: appCopy.interfaceFeedback.queueDeleteFailed, tone: "error" }); }
    finally { await refresh(); }
  };
  const edit = () => {
    // Queued attachments are not restored into the composer in this stage.
    onEdit(item.record.text);
    void remove();
  };
  const sendNow = async () => {
    try { await client?.request(`${path}/send-now`, { body: {} }); }
    catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "queued_message_not_next") {
        showToast({ message: copy.sendNowFailed, tone: "error" });
      }
    } finally { await refresh(); }
  };
  const status = failed ? copy.failedMessageStatus
    : item.total > 1 ? copy.queuedPosition(item.position, item.total) : copy.queuedMessageStatus;
  return <UserMessage message={item.record}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: t.length("--space-1") }}>
      <Text variant="caption" tone={failed ? "danger" : "tertiary"}>{status}</Text>
      {item.canSendNow ? <IconButton size="sm" variant="ghost" icon={icons.SendNow} label={copy.sendNow} onPress={sendNow} /> : null}
      <IconButton size="sm" variant="ghost" icon={icons.Edit} label={failed ? copy.retryFailedMessage : copy.editQueuedMessage} onPress={edit} />
      <IconButton size="sm" variant="ghost" icon={icons.Delete} label={failed ? copy.deleteFailedMessage : copy.deleteQueuedMessage} onPress={remove} />
    </View>
  </UserMessage>;
}
