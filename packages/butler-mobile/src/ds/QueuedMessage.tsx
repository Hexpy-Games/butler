import type { ReactNode } from "react";
import { View } from "react-native";
import { useTokens } from "../design/useTokens";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { inlineSelectable } from "./internal/selection";
import { MessageBubble } from "./MessageBubble";
import { Text } from "./Text";

export interface QueuedMessageProps {
  text: string;
  attachments?: ReactNode;
  status: string;
  tone?: "queued" | "sending" | "failed";
  sendNowLabel?: string;
  onSendNow?: () => void;
  editLabel?: string;
  onEdit?: () => void;
  deleteLabel: string;
  onDelete: () => void;
}

export function QueuedMessage({
  text, attachments, status, tone = "queued", sendNowLabel, onSendNow, editLabel, onEdit, deleteLabel, onDelete,
}: QueuedMessageProps) {
  const t = useTokens();
  const failed = tone === "failed";
  const disabled = tone === "sending";
  return <View style={{ alignSelf: "flex-end", maxWidth: "80%", gap: t.length("--space-1"), alignItems: "flex-end" }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-1") }}>
      <Icon glyph={failed ? icons.AlertCircle : icons.Clock3} size="xs" tone={failed ? "danger" : "secondary"} />
      <Text variant="caption" tone={failed ? "danger" : "secondary"}>{status}</Text>
    </View>
    {text ? <MessageBubble variant={failed ? "failed" : "queued"}>
      <Text tone="secondary" selectable={inlineSelectable}>{text}</Text>
    </MessageBubble> : null}
    {attachments}
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: t.length("--space-1") }}>
      {sendNowLabel && onSendNow ? <Button size="sm" variant="ghost" label={sendNowLabel} onPress={onSendNow} disabled={disabled} /> : null}
      {onEdit ? <IconButton size="sm" variant="ghost" icon={icons.Edit} label={editLabel ?? ""} onPress={onEdit} disabled={disabled} /> : null}
      <IconButton size="sm" variant="ghost" icon={icons.Delete} label={deleteLabel} onPress={onDelete} disabled={disabled} />
    </View>
  </View>;
}
