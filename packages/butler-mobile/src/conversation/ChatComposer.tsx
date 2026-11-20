import { useRef, useState } from "react";
import { router } from "expo-router";
import type { CreateSessionRequest, CreateSessionResult, MessageFileRef, MessageSendRequest, MessageSendResult, SessionView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy, reasoningEffortLabel } from "../../../butler-i18n/src/index.ts";
import { AttachmentTiles, Button, Composer, ComposerDock, ContextRing, icons, ListRow, Sheet, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { ContextBody } from "./SessionInfoSheet";
import { ModelSheet } from "./ModelSheet";
import { useAttachments } from "./useAttachments";
import { useControls } from "./useControls";
import { titleFromPrompt } from "./sessions";

export function ChatComposer({ id, project, group, view, hasDecision, text, setText, onPending, refreshQueue, onHeightChange, onSend }: {
  id?: string; project?: string; group?: string; view: SessionView | null; hasDecision: boolean;
  text: string; setText(text: string): void; onPending(text: string | null): void;
  refreshQueue(): Promise<void>; onHeightChange(height: number): void; onSend(): void;
}) {
  const copy = useMobileCopy();
  const { client } = useConversation();
  const locale = useAppLocale();
  const attachments = useAttachments(id);
  const model = useControls(id);
  const [sheet, setSheet] = useState<"attach" | "model" | "context" | null>(null);
  const turn = view?.active_turn;
  const ready = attachments.items.flatMap(item => item.status === "ready" && item.file ? [item.file] : []);
  const uploading = attachments.items.some(item => item.status === "uploading");
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !hasDecision;
  const { busy, setBusy, send } = useMessageSend({ id, project, group, text, setText, ready, attachments,
    activeTurn: !!turn, canSend, onPending, onSend, refreshQueue });
  const stop = async () => {
    if (!client || busy || !turn) return;
    setBusy(true);
    try { await client.request(`/turns/${encodeURIComponent(turn.id)}/cancel`, { body: {} }); }
    catch { showToast({ message: copy.chat.stopFailed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <ComposerDock onHeightChange={onHeightChange}>
    <Composer value={text} onChangeText={setText} placeholder={copy.chat.placeholder} canSend={canSend}
      mode={turn?.cancellable && !text.trim() && !ready.length ? "stop" : "send"} busy={busy} disabled={!id && busy} onSend={send} onStop={stop}
      sendLabel={copy.chat.send} stopLabel={copy.chat.stop} attach={id ? { label: copy.chat.attach, onPress: () => setSheet("attach") } : undefined}
      attachments={attachments.items.length ? <AttachmentTiles layout="row" items={attachments.items.map(item => ({
        key: item.key, name: item.name, kind: item.kind, image: item.kind === "image" ? { uri: item.uri } : undefined,
        extension: item.name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
        upload: item.status === "ready" ? undefined : item.status,
      }))} onRemove={attachments.remove} removeLabel={copy.chat.removeAttachment}
        uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
      leading={model.controls ? <Button variant="ghost" iconEnd={icons.ChevronDown} onPress={() => setSheet("model")}
        label={`${model.current?.display_name ?? model.controls.model} · ${reasoningEffortLabel(model.controls.reasoning_effort, locale)}`} /> : null}
      trailing={view?.context ? <ContextRing ratio={view.context.ratio} label={copy.chat.contextUsed(Math.round(view.context.ratio * 100))}
        onPress={() => setSheet("context")} /> : null} />
    <ModelSheet {...model} open={sheet === "model"} onClose={() => setSheet(null)} />
    <Sheet open={sheet === "context"} onClose={() => setSheet(null)} title={copy.chat.context} cancelLabel={copy.chat.close}>
      {view?.context ? <ContextBody context={view.context} /> : null}
    </Sheet>
    <Sheet open={sheet === "attach"} onClose={() => setSheet(null)} title={copy.chat.attach} cancelLabel={copy.chat.close}>
      {model.current?.image_input_support !== "unsupported" ? <ListRow icon={icons.Image} title={copy.chat.attachPhoto}
        onPress={() => { setSheet(null); void attachments.pick("photo"); }} /> : null}
      <ListRow icon={icons.File} title={copy.chat.attachFile} onPress={() => { setSheet(null); void attachments.pick("file"); }} />
    </Sheet>
  </ComposerDock>;
}

function useMessageSend({ id, project, group, text, setText, ready, attachments, activeTurn, canSend, onPending, onSend, refreshQueue }: {
  id?: string; project?: string; group?: string; text: string; setText(text: string): void;
  ready: MessageFileRef[]; attachments: ReturnType<typeof useAttachments>; activeTurn: boolean; canSend: boolean;
  onPending(text: string | null): void; onSend(): void; refreshQueue(): Promise<void>;
}) {
  const { client } = useConversation();
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const send = async () => {
    if (inFlight.current || !client || busy || !canSend) return;
    inFlight.current = true;
    onSend();
    setBusy(true);
    if (!id) onPending(text);
    const keys = attachments.items.filter(item => item.status === "ready" && item.file).map(item => item.key);
    let sessionId = id;
    const title = titleFromPrompt(text, appCopy.space.newChat);
    try {
      if (!sessionId) {
        const body: CreateSessionRequest = { kind: project ? "project" : "chat", workspace_mode: "local", title,
          ...(project ? { project_id: project } : {}), ...(group ? { group_id: group } : {}) };
        const { session } = await client.request<CreateSessionResult>("/sessions", { body });
        sessionId = session.id;
      }
      const body: MessageSendRequest = { chat_id: sessionId, text: text.trim(),
        client_message_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        attachments: ready.map(file => ({ file_id: file.file_id })), queue_policy: activeTurn ? "enqueue_if_busy" : "send_now" };
      const result = await client.request<MessageSendResult>("/messages", { body });
      setText("");
      attachments.removeMany(keys);
      if (result.queued) await refreshQueue();
      if (!id) router.replace({ pathname: "/chat/[id]", params: { id: sessionId, title } });
    } catch {
      showToast({ message: copy.chat.sendFailed, tone: "error" });
      if (!id && sessionId) router.replace({ pathname: "/chat/[id]", params: { id: sessionId, title, text } });
    } finally { inFlight.current = false; setBusy(false); onPending(null); }
  };
  return { busy, setBusy, send };
}
