import { MessageResults } from "@/outputs/MessageResults";
import { useState } from "react";
import { Platform, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ConversationMessage, ProgressSummaryRow, SessionView, SessionViewTurn, StewardChild } from "../../../butler-protocol/src/index.ts";
import { toMarkdown } from "../../../butler-protocol/src/answer-blocks-markdown.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { AttachmentTiles, Button, IconButton, icons, Markdown, MessageBubble, showToast, Text, TextSelectionScope, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { documentKindLabel } from "./documents";
import { BranchSheet } from "./BranchSheet";
import { MessageActivity } from "./ActivityHistory";
import { useSelectableRow } from "@/ds/internal/textSelection";
import { StewardCard } from "./StewardCard";

export function messageCopyText(message: ConversationMessage): string {
  return message.role === "user" ? message.text : [message.text, ...(message.answer_blocks ?? []).map(set => toMarkdown(set.spec, url => url))].filter(Boolean).join("\n\n");
}

export function UserMessage({ message, children, selectable }: {
  message: Pick<ConversationMessage, "text" | "attachments" | "content_parts">; children: React.ReactNode; selectable?: boolean;
}) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const t = useTokens();
  const { pairing } = useConversation();
  const references = message.content_parts?.parts.filter(part => part.type === "project_source_ref") ?? [];
  const text = message.content_parts ? message.content_parts.parts.filter(part => part.type === "text").map(part => part.text).join("") : message.text;
  return <View style={{ alignSelf: "flex-end", maxWidth: "80%", gap: t.length("--space-1") }}>
    <MessageBody selectable={selectable} style={{ gap: t.length("--space-1") }}>
      {text.trim() ? <MessageBubble><Text selectable>{text}</Text></MessageBubble> : null}
      {message.attachments?.length ? <AttachmentTiles layout="wrap" items={message.attachments.map(file => ({
        key: file.file_id, name: file.safe_name, kind: file.kind === "image" || file.mime_type.startsWith("image/") ? "image" : "file",
        image: pairing && (file.kind === "image" || file.mime_type.startsWith("image/"))
          ? { uri: new URL(file.url, pairing.origin).href, headers: { Authorization: `Bearer ${pairing.deviceToken}` } } : undefined,
        extension: file.safe_name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
        meta: file.size_bytes < 1024 * 1024 ? `${Math.round(file.size_bytes / 1024)} KB` : `${(file.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
      }))} uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
      {references.length ? <AttachmentTiles layout="wrap" items={references.map((part, index) => ({
        key: `${part.source.kind}:${part.source.id}:${index}`, name: part.titleSnapshot, kind: "file",
        extension: documentKindLabel(part.source.kind, appCopy),
      }))} uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
    </MessageBody>
    {children}
  </View>;
}

export function Message({ message, latestTurn, sessionId, projectId, stewardChild, liveRows }: {
  stewardChild?: { child: StewardChild; turn: SessionViewTurn };
  message: ConversationMessage; latestTurn?: SessionView["latest_turn"]; sessionId?: string; projectId?: string;
  liveRows?: ProgressSummaryRow[];
}) {
  const copy = useMobileCopy();
  const t = useTokens();
  const settled = useSelectableRow(message.id);
  const selectable = Platform.OS !== "ios" || (settled && message.status !== "streaming");
  if (message.role === "user") return <UserMessage message={message} selectable={selectable}>
    <MessageInfo message={message} />
  </UserMessage>;
  const bubble = sessionId === "general";
  const failed = message.status === "failed" || message.delivery_state === "system_error" || message.delivery_state === "failed_system";
  const cancelled = message.status === "cancelled" || message.delivery_state === "cancelled";
  return <View style={{ ...(bubble ? { alignSelf: "flex-start", width: "90%" } : { width: "100%" }), gap: t.length("--space-1") }}>
    {!bubble ? <MessageActivity message={message} liveRows={liveRows} /> : null}
    <MessageBody selectable={selectable} style={{ gap: t.length(bubble ? "--space-1" : "--space-3"), ...(bubble ? { alignSelf: "flex-start" } : {}) }}>
      {bubble ? (message.text.trim() ? <MessageBubble><Markdown text={message.text} /></MessageBubble> : null)
        : <Markdown text={message.text} />}
      {message.answer_blocks?.map((set, index) => <Markdown key={index} text={toMarkdown(set.spec, url => url)} />)}
      {failed ? <Text tone="danger">{copy.chat.failed}</Text> : null}
      {cancelled ? <Text tone="tertiary">{copy.chat.cancelled}</Text> : null}
    </MessageBody>
    <MessageResults message={message} />
    {stewardChild ? <StewardCard child={stewardChild.child} /> : null}
    {message.status !== "streaming" && (message.text.trim() || message.answer_blocks?.length) ? <MessageInfo message={message}
      sessionId={sessionId} projectId={projectId}
      retryable={failed && message.turn_id === latestTurn?.id && latestTurn?.retryable} /> : null}
  </View>;
}

function MessageInfo({ message, retryable, sessionId, projectId }: {
  message: ConversationMessage; retryable?: boolean; sessionId?: string; projectId?: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [branch, setBranch] = useState<"chat" | "project" | null>(null);
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale);
  const t = useTokens();
  const { client } = useConversation();
  const user = message.role === "user";
  const settled = !!message.text.trim() && (!message.status || ["delivered", "completed", "sent"].includes(message.status));
  const branchable = message.role === "assistant" && settled && (sessionId === "general" || !!projectId);
  const timestamp = user ? message.created_at : message.updated_at ?? message.created_at;
  const time = timestamp ? <Text variant="caption" tone="tertiary">
    {new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
  </Text> : null;
  const copyText = async () => {
    await Clipboard.setStringAsync(messageCopyText(message));
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
    {branchable ? <>
      <IconButton icon={icons.BranchChat} size="sm" label={appCopy.interfaceStatus.branchChat} onPress={() => setBranch("chat")} />
      <IconButton icon={icons.BranchProject} size="sm" label={appCopy.interfaceStatus.branchProject} onPress={() => setBranch("project")} />
    </> : null}
    {user ? null : time}
    {branch && sessionId ? <BranchSheet key={branch} sourceSessionId={sessionId} sourceMessageId={message.id}
      project={branch === "project"} projectId={projectId} onClose={() => setBranch(null)} /> : null}
  </View>;
}

function MessageBody({ style, children, selectable = true }: { style: object; children: React.ReactNode; selectable?: boolean }) {
  return <TextSelectionScope enabled={selectable}><View style={style}>{children}</View></TextSelectionScope>;
}
