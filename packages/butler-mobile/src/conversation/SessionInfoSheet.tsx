import { useEffect, useState } from "react";
import { View } from "react-native";
import type { SessionPendingAsks, SessionView } from "../../../butler-protocol/src/index.ts";
import { ListRow, Sheet, Text, useTokens } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { ContextUsage } from "./usage/ContextUsage";
import { useControls } from "./useControls";
import { useConversation } from "./live";

export function SessionInfoSheet({ open, onClose, id, title, view }: {
  open: boolean; onClose(): void; id: string; title: string; view: SessionView | null;
}) {
  const copy = useMobileCopy();
  const model = useControls(open ? id : undefined);
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
        <ContextUsage open={open} context={view.context} sessionId={id} models={model.models} model={model.current} />
      </View> : null}
      {attachments.length ? <View style={section}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.infoAttachments}</Text>
        {attachments.map(file => <ListRow key={file.file_id} title={file.safe_name} meta={`${Math.round(file.size_bytes / 1024)} KB`} />)}
      </View> : null}
    </View>
  </Sheet>;
}
