import { useEffect, useState } from "react";
import { View } from "react-native";
import type { SessionPendingAsks, SessionView } from "../../../butler-protocol/src/index.ts";
import { icons, ListGroup, ListGroupItem, ListRow, Sheet, useTokens } from "@/ds";
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
  return <Sheet open={open} onClose={onClose} title={copy.chat.info} description={title} cancelLabel={copy.chat.close}>
    <View style={{ gap: t.length("--space-4") }}>
      {pending?.asks.length ? <ListGroup label={copy.chat.infoAsks}>
        {pending.asks.map(ask => <ListRow key={ask.ask_id} title={ask.title} />)}
      </ListGroup> : null}
      <ListGroup label={copy.chat.infoWorkspace}>
        {view?.branch?.available ? <ListRow icon={icons.Folder} title={view.branch.workspace_label ?? view.branch.workspace_path ?? copy.chat.infoNoWorkspace}
          meta={view.branch.branch_name} /> : <ListRow icon={icons.Folder} title={copy.chat.infoNoWorkspace} />}
      </ListGroup>
      {view?.context ? <ListGroup label={copy.chat.context}>
        <ListGroupItem><ContextUsage open={open} context={view.context} sessionId={id} models={model.models} model={model.current} /></ListGroupItem>
      </ListGroup> : null}
      {attachments.length ? <ListGroup label={copy.chat.infoAttachments}>
        {attachments.map(file => <ListRow key={file.file_id} icon={icons.File} title={file.safe_name} meta={`${Math.round(file.size_bytes / 1024)} KB`} />)}
      </ListGroup> : null}
    </View>
  </Sheet>;
}
