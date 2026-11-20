import { useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ConversationMessage, SessionView } from "../../../butler-protocol/src/index.ts";
import { toMarkdown } from "../../../butler-protocol/src/answer-blocks-markdown.ts";
import { RADIUS } from "@/design/tokens";
import { AttachmentTiles, Button, IconButton, icons, Markdown, showToast, Text, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";

export function UserMessage({ message, children }: {
  message: Pick<ConversationMessage, "text" | "attachments">; children: React.ReactNode;
}) {
  const copy = useMobileCopy();
  const t = useTokens();
  const { pairing } = useConversation();
  return <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: t.length("--space-1") }}>
    {message.text ? <View style={{ backgroundColor: t.color("--user-message-bg"), borderRadius: t.length(RADIUS),
      paddingVertical: t.length("--space-3"), paddingHorizontal: t.length("--space-4") }}>
      <Text selectable>{message.text}</Text>
    </View> : null}
    {message.attachments?.length ? <AttachmentTiles layout="wrap" items={message.attachments.map(file => ({
      key: file.file_id, name: file.safe_name, kind: file.kind === "image" || file.mime_type.startsWith("image/") ? "image" : "file",
      image: pairing && (file.kind === "image" || file.mime_type.startsWith("image/"))
        ? { uri: new URL(file.url, pairing.origin).href, headers: { Authorization: `Bearer ${pairing.deviceToken}` } } : undefined,
      extension: file.safe_name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
      meta: file.size_bytes < 1024 * 1024 ? `${Math.round(file.size_bytes / 1024)} KB` : `${(file.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
    }))} uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
    {children}
  </View>;
}

export function Message({ message, latestTurn }: { message: ConversationMessage; latestTurn?: SessionView["latest_turn"] }) {
  const copy = useMobileCopy();
  const t = useTokens();
  if (message.role === "user") return <UserMessage message={message}><MessageInfo message={message} /></UserMessage>;
  const failed = message.status === "failed" || message.delivery_state === "system_error" || message.delivery_state === "failed_system";
  const cancelled = message.status === "cancelled" || message.delivery_state === "cancelled";
  return <View style={{ width: "100%", gap: t.length("--space-1") }}>
    <View style={{ gap: t.length("--space-3") }}>
      <Markdown text={message.text} />
      {message.answer_blocks?.map((set, index) => <Markdown key={index} text={toMarkdown(set.spec, url => url)} />)}
      {failed ? <Text tone="danger">{copy.chat.failed}</Text> : null}
      {cancelled ? <Text tone="tertiary">{copy.chat.cancelled}</Text> : null}
    </View>
    {message.status !== "streaming" ? <MessageInfo message={message}
      retryable={failed && message.turn_id === latestTurn?.id && latestTurn?.retryable} /> : null}
  </View>;
}

function MessageInfo({ message, retryable }: { message: ConversationMessage; retryable?: boolean }) {
  const [retrying, setRetrying] = useState(false);
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const t = useTokens();
  const { client } = useConversation();
  const user = message.role === "user";
  const timestamp = user ? message.created_at : message.updated_at ?? message.created_at;
  const time = timestamp ? <Text variant="caption" tone="tertiary">
    {new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
  </Text> : null;
  const copyText = async () => {
    const text = user ? message.text : [message.text, ...(message.answer_blocks ?? []).map(set => toMarkdown(set.spec, url => url))].join("\n\n");
    await Clipboard.setStringAsync(text);
    showToast({ message: copy.chat.copied, tone: "success" });
  };
  const retry = async () => {
    setRetrying(true);
    try { await client?.request(`/turns/${encodeURIComponent(message.turn_id!)}/retry`, { body: {} }); }
    catch { showToast({ message: copy.chat.retryFailed, tone: "error" }); }
    finally { setRetrying(false); }
  };
  return <View style={{ flexDirection: "row", alignItems: "center", justifyContent: user ? "flex-end" : "flex-start", gap: t.length("--space-1") }}>
    {retryable ? <Button variant="secondary" iconStart={icons.Retry} label={copy.chat.retry} onPress={retry} disabled={retrying} /> : null}
    {user ? time : null}
    <IconButton icon={icons.Copy} variant="ghost" size="sm" label={copy.chat.copy} onPress={copyText} />
    {user ? null : time}
  </View>;
}
