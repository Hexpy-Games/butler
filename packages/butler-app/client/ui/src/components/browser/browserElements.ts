import { create } from "zustand";
import { api, uploadMessageFile } from "@/app/api";
import { libraryChanged } from "@/app/libraryEvents";
import { normalizeComposerDraft, readCachedComposerDraft, writeLocalComposerDraft } from "@/app/composerDraftCache";
import { useComposerStore } from "../conversation/composerStore";
import type { ElementAttachment } from "../../../../shared/browser-element";
export type { ElementAttachment } from "../../../../shared/browser-element";

export interface PickedElement {
  id: string; tab: string; title: string; text: string; tag: string; url: string; site: string;
  crop: string; capturedAt: string; rect: { x: number; y: number; width: number; height: number };
  ref?: string; observation?: string;
}
/** A scrap's HTML copy of exactly the picked part; only its size is listed with the scrap. */
export interface ScrapSnapshot { html?: string; width: number; height: number }
export const useElementDraft = create<{ session: string; items: ElementAttachment[] }>(() => ({ session: "", items: [] }));

export async function restoreElementDraft(session: string) {
  useElementDraft.setState({ session, items: [] });
  const draft = await readCachedComposerDraft(session);
  if (useElementDraft.getState().session === session) useElementDraft.setState({ items: draft?.element_attachments ?? [] });
}
async function persist(session: string, items: ElementAttachment[]) {
  const composer = useComposerStore.getState();
  const draft = await readCachedComposerDraft(session);
  const snapshot = { schema: "butler.composer-draft.v1" as const, session_id: session,
    text: composer.draftSessionId === session ? composer.text : draft?.text ?? "",
    content_parts: composer.draftSessionId === session ? composer.contentParts : draft?.content_parts,
    element_attachments: items, updated_at: new Date().toISOString() };
  if (!normalizeComposerDraft(snapshot, session)) throw new Error("Element draft exceeds the draft budget.");
  writeLocalComposerDraft(snapshot);
  const saved = await window.butlerApp?.writeCachedComposerDraft?.({ snapshot });
  if (saved && typeof saved === "object" && "ok" in saved && saved.ok === false) throw new Error("Element draft could not be saved.");
  if (useElementDraft.getState().session === session) useElementDraft.setState({ items });
}
// Serialize commands per destination; late upload/restore cannot overwrite newer chips.
const writes = new Map<string, Promise<void>>();
function mutate(session: string, run: () => Promise<void>) {
  const operation = (writes.get(session) ?? Promise.resolve()).catch(() => {}).then(run);
  writes.set(session, operation);
  void operation.finally(() => { if (writes.get(session) === operation) writes.delete(session); }).catch(() => {});
  return operation;
}
export function attachElements(session: string, elements: PickedElement[]) {
  return mutate(session, async () => {
    const items: ElementAttachment[] = [];
    for (const element of elements) {
      const image = await (await fetch(element.crop)).blob();
      const crop = await uploadMessageFile(new File([image], "element.jpg", { type: "image/jpeg" }), session);
      const data = { kind: "untrusted_web_page_data", ...element, crop: { file_id: crop.file_id }, ref: undefined, observation: undefined };
      const file = await uploadMessageFile(new File([JSON.stringify({ untrusted_content: data })], "element.json", { type: "application/json" }), session);
      items.push({ id: element.id, title: element.title, site: element.site, file, crop });
    }
    const draft = await readCachedComposerDraft(session);
    const prior = draft?.element_attachments ?? [];
    await persist(session, [...prior.filter(p => !items.some(i => i.id === p.id)), ...items]);
  });
}
export function removeElement(session: string, id: string) {
  return mutate(session, async () => {
    const draft = await readCachedComposerDraft(session);
    await persist(session, (draft?.element_attachments ?? []).filter(item => item.id !== id));
  });
}
export function clearElementDraft(session: string, submitted: ElementAttachment[]) {
  return mutate(session, async () => {
    const draft = await readCachedComposerDraft(session);
    await persist(session, (draft?.element_attachments ?? []).filter(item => !submitted.some(old => old.id === item.id)));
  });
}
/** The live pick's HTML copy, taken now while its page is open; null keeps the scrap image-only. */
async function snapshotOf(element: PickedElement): Promise<ScrapSnapshot | null> {
  try {
    const copy = await window.butlerBrowser?.call("selection-snapshot", { id: element.tab, item: element.id }) as ScrapSnapshot | null | undefined;
    return copy?.html ? { html: copy.html, width: copy.width, height: copy.height } : null;
  } catch { return null; }
}
/** Saves picks as scraps (into `group` when given) and returns their ids. */
export async function scrapElements(elements: PickedElement[], group?: string) {
  const ids: string[] = [];
  for (const element of elements) {
    const snapshot = await snapshotOf(element);
    const saved = await api<{ id: string }>("/library", { method: "POST", body: JSON.stringify({ ...element, kind: "scrap", ...(snapshot ? { snapshot } : {}) }) });
    ids.push(saved?.id ?? element.id);
  }
  if (group && ids.length) await api("/library/items", { method: "PATCH", body: JSON.stringify({ ids, group }) });
  libraryChanged();
  return ids;
}

export function attachLibraryReference(session: string, item: ElementAttachment) {
  return mutate(session, async () => {
    const draft=await readCachedComposerDraft(session);
    await persist(session,[...(draft?.element_attachments ?? []).filter(old=>old.id!==item.id),item]);
  });
}
