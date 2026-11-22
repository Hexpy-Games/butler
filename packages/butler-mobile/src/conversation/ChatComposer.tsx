import { useImperativeHandle, useRef, useState } from "react";
import { router } from "expo-router";
import type { CreateSessionRequest, CreateSessionResult, MessageFileRef, MessageSendRequest, MessageSendResult, ProjectDashboardDocument, SessionView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy, reasoningEffortLabel } from "../../../butler-i18n/src/index.ts";
import { AttachmentTiles, IconButton, Composer, ComposerDock, ContextRing, icons, ListGroup, ListRow, Sheet, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { ContextUsage } from "./usage/ContextUsage";
import { ModelMark } from "./ModelMark";
import { ModelSheet } from "./ModelSheet";
import { useAttachments } from "./useAttachments";
import type { DraftControls } from "./draftControls";
import { useControls } from "./useControls";
import { titleFromPrompt } from "./sessions";
import { ProjectDocumentsSheet } from "./ProjectDocumentsSheet";
import { documentContent, documentKindLabel } from "./documents";

export type ChatComposerHandle = { send(text?: string): Promise<void> };

export function ChatComposer({ ref, id, project, group, view, hasDecision, text, setText, onPending,
  refreshQueue, onHeightChange, onSend, backdrop }: {
  ref?: React.Ref<ChatComposerHandle>; id?: string; project?: string; group?: string; view: SessionView | null; hasDecision: boolean;
  text: string; setText(text: string): void; onPending(text: string | null): void;
  refreshQueue(): Promise<void>; onHeightChange(height: number): void; onSend(): void;
  backdrop?: { color: string; visible: boolean };
}) {
  const copy = useMobileCopy();
  const { client } = useConversation();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale);
  const attachments = useAttachments(id);
  const model = useControls(id);
  const [sheet, setSheet] = useState<"attach" | "documents" | "model" | "context" | null>(null);
  const pendingAction = useRef<"documents" | "photo" | "file" | null>(null);
  const pendingDocument = useRef<ProjectDashboardDocument | null>(null);
  const projectId = view?.project_id ?? project;
  const turn = view?.active_turn;
  const ready = attachments.items.flatMap(item => item.status === "ready" && item.file ? [item.file] : []);
  const hasReferences = attachments.items.some(item => item.status === "ready" && item.reference);
  const uploading = attachments.items.some(item => item.status === "uploading");
  const canSend = (!!text.trim() || ready.length > 0 || hasReferences) && !uploading && !hasDecision;
  const { busy, setBusy, send } = useMessageSend({ id, project, group, text, setText, ready, attachments,
    activeTurn: !!turn, canSend, onPending, onSend, refreshQueue, controls: model.controls });
  useImperativeHandle(ref, () => ({ send }));
  const stop = async () => {
    if (!client || busy || !turn) return;
    setBusy(true);
    try { await client.request(`/turns/${encodeURIComponent(turn.id)}/cancel`, { body: {} }); }
    catch { showToast({ message: copy.chat.stopFailed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <ComposerDock backdrop={backdrop} onHeightChange={onHeightChange}>
    <Composer value={text} onChangeText={setText} placeholder={copy.chat.placeholder} canSend={canSend}
      mode={turn?.cancellable && !text.trim() && !ready.length && !hasReferences ? "stop" : "send"} busy={busy} disabled={!id && busy} onSend={() => { void send(); }} onStop={stop}
      sendLabel={copy.chat.send} stopLabel={copy.chat.stop} attach={{ label: copy.chat.attach, onPress: () => setSheet("attach") }}
      attachments={attachments.items.length ? <AttachmentTiles layout="row" items={attachments.items.map(item => ({
        key: item.key, name: item.name, kind: item.kind, image: item.kind === "image" && item.uri ? { uri: item.uri } : undefined,
        extension: item.reference ? documentKindLabel(item.reference.source.kind, appCopy)
          : item.name.trim().match(/\.([^.]+)$/)?.[1]?.toUpperCase() || copy.chat.fileLabel,
        upload: item.status === "ready" ? undefined : item.status,
      }))} onRemove={attachments.remove} removeLabel={copy.chat.removeAttachment}
        uploadingLabel={copy.chat.uploading} failedLabel={copy.chat.uploadFailed} /> : null}
      trailing={<>
        {view?.context ? <ContextRing ratio={view.context.ratio} label={copy.chat.contextUsed(Math.round(view.context.ratio * 100))}
          onPress={() => setSheet("context")} /> : <ContextRing ratio={0} label={copy.chat.contextUsed(0)} onPress={() => {}} />}
        {model.controls ? <IconButton size="control" variant="ghost" icon={<ModelMark model={model.current} />}
          label={`${model.current?.display_name ?? model.controls.model} · ${reasoningEffortLabel(model.controls.reasoning_effort, locale)}`}
          onPress={() => setSheet("model")} /> : null}
      </>} />
    <ModelSheet {...model} open={sheet === "model"} onClose={() => setSheet(null)} />
    <Sheet open={sheet === "context"} onClose={() => setSheet(null)} title={copy.chat.context} cancelLabel={copy.chat.close}>
      {view?.context ? <ContextUsage open={sheet === "context"} context={view.context} sessionId={id} models={model.models} model={model.current} /> : null}
    </Sheet>
    <Sheet open={sheet === "attach"} onClose={() => setSheet(null)} title={copy.chat.attach} cancelLabel={copy.chat.close}
      onClosed={() => {
        const action = pendingAction.current;
        pendingAction.current = null;
        if (action === "documents") setSheet("documents");
        else if (action) void attachments.pick(action);
      }}>
      <ListGroup>
        {projectId ? <ListRow icon={icons.Document} title={appCopy.interfaceDetails.projectDocuments} navigates
          onPress={() => { pendingAction.current = "documents"; setSheet(null); }} /> : null}
        {model.current?.image_input_support !== "unsupported" ? <ListRow icon={icons.Image} title={copy.chat.attachPhoto}
          onPress={() => { pendingAction.current = "photo"; setSheet(null); }} /> : null}
        <ListRow icon={icons.File} title={copy.chat.attachFile} onPress={() => { pendingAction.current = "file"; setSheet(null); }} />
      </ListGroup>
    </Sheet>
    {projectId ? <ProjectDocumentsSheet key={projectId} projectId={projectId} open={sheet === "documents"}
      onClose={() => setSheet(null)} onPick={document => { pendingDocument.current = document; setSheet(null); }}
      onClosed={() => {
        const document = pendingDocument.current;
        pendingDocument.current = null;
        if (document) void attachments.addProjectDocument(document);
      }} /> : null}
  </ComposerDock>;
}

function useMessageSend({ id, project, group, text, setText, ready, attachments, activeTurn, canSend, onPending, onSend, refreshQueue, controls }: {
  id?: string; project?: string; group?: string; text: string; setText(text: string): void;
  ready: MessageFileRef[]; attachments: ReturnType<typeof useAttachments>; activeTurn: boolean; canSend: boolean;
  onPending(text: string | null): void; onSend(): void; refreshQueue(): Promise<void>; controls: DraftControls | undefined;
}) {
  const { client } = useConversation();
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const send = async (override?: string) => {
    const value = override ?? text;
    if (inFlight.current || !client || busy || (override === undefined && !canSend)) return;
    inFlight.current = true;
    onSend();
    setBusy(true);
    if (!id) onPending(value);
    const keys = attachments.items.filter(item => item.status === "ready" && (item.file || item.reference)).map(item => item.key);
    const references = attachments.items.flatMap(item => item.status === "ready" && item.reference ? [item.reference] : []);
    let sessionId = id;
    const title = titleFromPrompt(value, appCopy.space.newChat);
    try {
      if (!sessionId) {
        const body: CreateSessionRequest = { kind: project ? "project" : "chat", workspace_mode: "local", title,
          ...(project ? { project_id: project } : {}), ...(group ? { group_id: group } : {}) };
        const { session } = await client.request<CreateSessionResult>("/sessions", { body });
        sessionId = session.id;
        if (controls) await client.request(`/sessions/${encodeURIComponent(sessionId)}/controls`, {
          method: "PATCH", body: { model: controls.model, reasoning_effort: controls.reasoning_effort },
        }).catch(() => undefined);
      }
      const body: MessageSendRequest = { chat_id: sessionId, text: value.trim(),
        ...(references.length ? { content_parts: documentContent(value.trim(), references) } : {}),
        client_message_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        attachments: ready.map(file => ({ file_id: file.file_id })), queue_policy: activeTurn ? "enqueue_if_busy" : "send_now" };
      const result = await client.request<MessageSendResult>("/messages", { body });
      setText("");
      attachments.removeMany(keys);
      if (result.queued) await refreshQueue();
      if (!id) router.replace({ pathname: "/chat/[id]", params: { id: sessionId, title } });
    } catch {
      showToast({ message: copy.chat.sendFailed, tone: "error" });
      if (!id && sessionId) router.replace({ pathname: "/chat/[id]", params: { id: sessionId, title, text: value } });
    } finally { inFlight.current = false; setBusy(false); onPending(null); }
  };
  return { busy, setBusy, send };
}
