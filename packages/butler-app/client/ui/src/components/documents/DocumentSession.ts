import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { libraryChanged } from "@/app/libraryEvents";
import { notifyStatus } from "@/app/notifications";
import { documentPath, readDocument, restoreDocument, type EditableDocument } from "./documentApi";
import { mergeDocument } from "./documentMerge";
import type { DocumentUpdate } from "@/app/documentEvents";
export interface DocumentState { head?: EditableDocument; loadId: number; body: string; saved: boolean; editing: boolean; changed: DocumentUpdate["changed"]; failed: boolean }
/** One owner for lazy drafts and serialized server operations, including saves that finish after close. */
export class DocumentSession {
  state: DocumentState = { loadId: 0, body: "", saved: false, editing: false, changed: [], failed: false };
  private listeners = new Set<() => void>();
  private pending = Promise.resolve();
  private debounce?: ReturnType<typeof setTimeout>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private undoRev?: number;
  private running = false;
  private draft?: () => string;
  private dirty = false;
  constructor(readonly id: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<DocumentState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  registerDraft = (read: () => string) => {
    this.draft = read;
    return () => { if (this.draft === read) { this.captureDraft(); this.draft = undefined; } };
  };
  private captureDraft() {
    if (this.dirty && this.draft) {
      const body = this.draft(); this.dirty = false;
      this.update({ body });
    }
    return this.state.body;
  }
  private enqueue(work: () => Promise<void>) {
    this.pending = this.pending.then(work).catch(() => {
      this.update({ failed: true }); notifyStatus(appCopy.library.failed, { tone: "error" });
    });
    return this.pending;
  }
  load() { return this.enqueue(async () => this.accept(await readDocument(this.id))); }
  private accept(head: EditableDocument) {
    const old = this.state.head, ours = this.captureDraft();
    const body = old ? mergeDocument(old.body, ours, head.body) : head.body;
    this.update({ head, body, loadId: this.state.loadId + Number(body !== ours || !old), saved: body === head.body, failed: false });
  }
  draftChanged = () => {
    this.dirty = true;
    if (this.state.saved) this.update({ saved: false });
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.flush(); }, 800);
  };
  flush = () => { clearTimeout(this.debounce); this.captureDraft(); return this.enqueue(() => this.save()); };
  private async save(): Promise<void> {
    while (this.state.head) {
      const head = this.state.head, sent = this.captureDraft();
      if (sent === head.body) { this.update({ saved: true }); return; }
      try {
        const next = await api<EditableDocument>(documentPath(this.id), { method: "PUT", body: JSON.stringify({ body: sent, expected_rev: head.rev, author: "user" }) });
        const ours = this.captureDraft(), body = mergeDocument(sent, ours, next.body);
        this.update({ head: next, body, loadId: this.state.loadId + Number(body !== ours), saved: body === next.body, failed: false }); libraryChanged();
      } catch (error) {
        if ((error as { code?: string }).code !== "revision_conflict") throw error;
        this.accept(await readDocument(this.id));
      }
    }
  }
  remote(event: DocumentUpdate | null) {
    if (event && event.id !== this.id) return;
    return this.enqueue(async () => {
      const before = this.state.head, head = await readDocument(this.id);
      if (event?.author === "butler" && before) {
        if (event.rev > 1) this.undoRev ??= event.rev - 1;
        this.update({ editing: true, changed: [...this.state.changed, ...event.changed] });
        clearTimeout(this.finishTimer);
        if (!this.running) this.finishTimer = setTimeout(() => this.finishEditing(), 1500);
      }
      this.accept(head);
      if (this.state.body !== head.body) await this.save();
    });
  }
  setRunning(running: boolean) {
    const ended = this.running && !running; this.running = running;
    if (running) clearTimeout(this.finishTimer);
    else if (ended && this.state.editing) this.finishEditing();
  }
  private finishEditing() {
    clearTimeout(this.finishTimer);
    const rev = this.undoRev; this.undoRev = undefined;
    this.update({ editing: false, changed: [] });
    if (rev) this.notifyEdited(rev);
  }
  private notifyEdited(rev: number) {
    notifyStatus(appCopy.documents.edited, { action: { label: appCopy.library.undo, onClick: () => { void this.restore(rev); } } });
  }
  restore(rev: number) {
    return this.enqueue(async () => {
      await this.save();
      this.accept(await restoreDocument(this.id, rev));
      if (this.state.body !== this.state.head?.body) await this.save();
    });
  }
  close() {
    clearTimeout(this.finishTimer);
    if (this.state.editing) this.finishEditing();
    return this.flush();
  }
}
