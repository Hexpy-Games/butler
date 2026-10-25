import { relativeAge } from "@/app/utils";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DocumentEditor, DialogHeader, DialogTitle, DialogClose, X, DialogFooter, ScrollArea, Button, History, IconButton, Inline, Popover, PopoverContent, PopoverTrigger, VersionHistory, Typo, Stack } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { subscribeDocumentUpdates } from "@/app/documentEvents";
import { notifyStatus } from "@/app/notifications";
import { DocumentSession } from "./DocumentSession";
import { DocumentBody } from "./DocumentBody";
import { DocumentReadView } from "./DocumentReadView";
import { DocumentExportMenu } from "./DocumentExportMenu";
import { openDocument, readDocument, revisions, type DocumentRevision, type EditableDocument } from "./documentApi";
export function DocumentPage({ id, dialogTitle }: { id: string; dialogTitle?: string }) {
  useAppLocale();
  const session = useMemo(() => new DocumentSession(id, dialogTitle !== undefined), [id, dialogTitle]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [preview, setPreview] = useState<EditableDocument>();
  const previewRequest = useRef(0);
  const [history, setHistory] = useState<DocumentRevision[]>([]), [historyOpen, setHistoryOpen] = useState(false);
  const running = useButlerStore(store => {
    const chat = state.head?.chat_id;
    const view = chat ? (store.sessionViews[chat] ?? (store.sessionView?.session_id === chat ? store.sessionView : undefined)) : undefined;
    return Boolean(view?.active_turn && !["delivered", "failed", "cancelled"].includes(view.active_turn.state));
  });
  useEffect(() => { void session.load(); const unsubscribe = subscribeDocumentUpdates(event => { void session.remote(event); });
    return () => { unsubscribe(); void session.close(); }; }, [session]);
  useEffect(() => session.setRunning(running), [session, running]);
  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    void session.flush().then(() => revisions(id)).then(rows => { if (active) setHistory(rows); }, () => notifyStatus(appCopy.library.failed, { tone: "error" }));
    return () => { active = false; };
  }, [historyOpen, id, session, state.head?.rev]);
  const copy = appCopy.documents, doc = state.head;
  if (!doc) return <DocumentLayout dialogTitle={dialogTitle} title={dialogTitle ?? ""}><Typo.Caption>{state.failed ? appCopy.library.failed : appCopy.artifacts.loading}</Typo.Caption></DocumentLayout>;
  const select = (rev: number) => {
    const request = ++previewRequest.current;
    if (rev === session.state.head?.rev) { setPreview(undefined); return; }
    void readDocument(id, rev).then(doc => { if (request === previewRequest.current) setPreview(doc); }, () => notifyStatus(appCopy.library.failed, { tone: "error" }));
  };
  const restore = async () => { if (!preview) return; await session.restore(preview.rev); setPreview(undefined); setHistoryOpen(false); };
  return <DocumentLayout dialogTitle={dialogTitle} title={doc.title} note={state.editing ? copy.editing : state.undoRev ? <Inline gap="xs"><span>{copy.edited}</span><Button size="xs" variant="borderless" onClick={() => { void session.restore(state.undoRev!); }}>{appCopy.library.undo}</Button></Inline> : state.saved ? copy.saved : undefined}
    actions={<Inline gap="xs" wrap={false}><Popover open={historyOpen} onOpenChange={setHistoryOpen}><PopoverTrigger asChild><IconButton label={copy.versions}><History size="sm" /></IconButton></PopoverTrigger>
      <PopoverContent align="end"><VersionHistory label={copy.versions} currentLabel={copy.current} selectedId={String(preview?.rev ?? doc.rev)}
        entries={history.map(row => ({ id: String(row.rev), author: row.author, authorLabel: row.author === "butler" ? copy.butler : copy.me, time: relativeAge(row.updated_at), dateTime: row.updated_at }))}
        onSelect={rev => select(Number(rev))} action={preview ? <Button size="sm" onClick={() => { void restore(); }}>{copy.restore}</Button> : undefined} /></PopoverContent>
    </Popover>{doc.chat_id ? <Button size="xs" variant="ghost" onClick={() => openDocument(doc, true)}>{copy.originalChat}</Button> : null}<DocumentExportMenu prepare={async () => { await session.flush(); return preview ?? { ...session.state.head!, body: session.state.body }; }} /></Inline>}>
    <Stack gap="md">
      {preview ? <DocumentReadView doc={preview} /> : <DocumentBody key={id} doc={doc} body={state.body} loadId={state.loadId} changed={state.changed} editing={state.editing} flush={session.flush} registerDraft={session.registerDraft} onDirty={session.draftChanged} onBlur={session.flush} />}
    </Stack>
  </DocumentLayout>;
}

function DocumentLayout({ dialogTitle, title, actions, note, children }: {
  dialogTitle?: string; title: string; actions?: ReactNode; note?: ReactNode; children: ReactNode;
}) {
  if (dialogTitle === undefined) return <DocumentEditor title={<Typo.H2>{title}</Typo.H2>} actions={actions} note={note} data-test-class="editable-document">{children}</DocumentEditor>;
  return <>
    <DialogHeader><Inline justify="between" wrap={false}><Stack.Item shrink><DialogTitle>{title}</DialogTitle></Stack.Item><Inline gap="xs" wrap={false}>{actions}<DialogClose asChild><IconButton label={appCopy.common.close}><X size="sm" /></IconButton></DialogClose></Inline></Inline></DialogHeader>
    <ScrollArea fill><DocumentEditor title={null} note={note} data-test-class="editable-document">{children}</DocumentEditor></ScrollArea>
    <DialogFooter />
  </>;
}
