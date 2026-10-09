import { LibraryCard, OverflowActionMenu } from "@/butler-ds";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { deleteLibrary, type LibraryItem } from "./libraryStore";
import { browserCall, openBrowser } from "./browserBridge";
const labels = () => ({ scrap: appCopy.browser.element, document: appCopy.browser.document, bookmark: appCopy.browser.bookmarks, output: appCopy.browser.output });
export async function openLibraryItem(item: LibraryItem) {
  try {
    if (item.file) {
      if (item.session) useButlerStore.getState().openSession(item.session);
      useButlerStore.getState().openArtifact(item.id, { id: item.id, session_id: item.session as string, kind: "document", title: item.title, file_id: item.file.file_id, url: item.file.url, size_bytes: item.file.size_bytes, created_at: item.capturedAt }); return;
    }
    const url = item.output ? (await api<{ url:string }>(`/outputs/${item.output}/view`)).url : item.url;
    await openBrowser(); const id = await browserCall("create", { url }); if (id) await browserCall("activate", { id });
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export function LibraryItemCard({ item, onAttach }: { item: LibraryItem; onAttach: () => void }) {
  const copy = appCopy.browser;
  const remove = () => void deleteLibrary(item.id).catch(() => notifyStatus(copy.failed, { tone: "error" }));
  return <LibraryCard title={item.title} tag={labels()[item.kind]}
    meta={[item.site ?? item.folder, new Date(item.capturedAt).toLocaleDateString(document.documentElement.lang)].filter(Boolean).join(" · ")}
    media={item.crop ? { kind: "image", src: item.crop } : item.kind === "bookmark" ? { kind: "quote", text: new URL(item.url).host } : { kind: "document" }}
    onOpen={() => void openLibraryItem(item)} menu={<OverflowActionMenu label={copy.more} items={[
      { label: copy.attach, onSelect: onAttach }, { label: copy.openSource, onSelect: () => void openLibraryItem(item) },
      { label: copy.remove, variant: "destructive", onSelect: remove },
    ]} />} />;
}
