import { useEffect, useState } from "react";
import { View } from "react-native";
import type { ContextDetails, SessionPendingAsks, SessionView } from "../../../butler-protocol/src/index.ts";
import { ListRow, Sheet, Text, useTokens } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { useConversation } from "./live";

export function SessionInfoSheet({ open, onClose, id, title, view }: {
  open: boolean; onClose(): void; id: string; title: string; view: SessionView | null;
}) {
  const copy = useMobileCopy();
  const t = useTokens();
  const { client } = useConversation();
  const [pending, setPending] = useState<SessionPendingAsks | null>(null);
  useEffect(() => {
    setPending(null);
    if (!open || !client) return;
    let closed = false;
    void client.request<SessionPendingAsks>(`/sessions/${encodeURIComponent(id)}/pending-asks`)
      .then(next => { if (!closed) setPending(next); }).catch(() => {});
    return () => { closed = true; };
  }, [open, client, id]);
  const attachments = [...new Map((view?.messages ?? []).filter(message => message.role === "user")
    .flatMap(message => message.attachments ?? []).map(file => [file.file_id, file])).values()];
  const section = { gap: t.length("--space-4") };
  return <Sheet open={open} onClose={onClose} title={copy.chat.info} description={title} cancelLabel={copy.chat.close}>
    <View style={section}>
      {pending?.asks.length ? <View style={section}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.infoAsks}</Text>
        <Text tone="secondary">{pending.asks.length}</Text>
        {pending.asks.map(ask => <ListRow key={ask.ask_id} title={ask.title} />)}
      </View> : null}
      <View style={section}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.infoWorkspace}</Text>
        {view?.branch?.available ? <ListRow title={view.branch.label ?? view.branch.workspace_path ?? copy.chat.infoNoWorkspace}
          description={view.branch.branch} /> : <Text tone="secondary">{copy.chat.infoNoWorkspace}</Text>}
      </View>
      {view?.context ? <View style={section}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.context}</Text>
        <ContextBody context={view.context} />
      </View> : null}
      {attachments.length ? <View style={section}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.infoAttachments}</Text>
        {attachments.map(file => <ListRow key={file.file_id} title={file.safe_name} meta={`${Math.round(file.size_bytes / 1024)} KB`} />)}
      </View> : null}
    </View>
  </Sheet>;
}

export function ContextBody({ context }: { context: ContextDetails }) {
  const copy = useMobileCopy();
  const t = useTokens();
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
  return <View style={{ gap: t.length("--space-4") }}>
    <Text variant="h4">{copy.chat.contextUsed(Math.round(context.ratio * 100))}</Text>
    <Text tone="secondary">{copy.chat.contextTokens(fmt(context.used_tokens), fmt(context.budget_tokens))}</Text>
    {context.auto_compact_at_tokens ? <Text tone="secondary">{copy.chat.contextCompact(fmt(context.auto_compact_at_tokens))}</Text> : null}
  </View>;
}
