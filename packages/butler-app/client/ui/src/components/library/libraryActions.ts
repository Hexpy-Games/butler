import { documentKind } from "./documentKinds";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import type { LibraryItem } from "../browser/libraryStore";
import { errorCode, patchItems } from "./libraryApi";
import { useLibraryNames } from "./libraryNav";

const failed = (error?: unknown) => notifyStatus(errorCode(error) === "library_group_kind_mismatch" ? appCopy.library.mixedKinds : appCopy.library.failed, { tone: "error" });

/** Puts items into a group (null: out of their group) with an undo that restores each item's own group. */
export async function fileItems(items: LibraryItem[], group: string | null) {
  const moving = items.filter((item) => (item.group ?? null) !== group);
  if (!moving.length) return;
  const name = group ? useLibraryNames.getState().groups[group]?.name ?? "" : "";
  const target = group ? useLibraryNames.getState().groups[group] : undefined;
  if (target && moving.some((item) => item.kind !== target.kind)) { failed({ code: "library_group_kind_mismatch" }); return; }
  try {
    syncDetail((await patchItems({ ids: moving.map((item) => item.id), group })).items);
    if (!group) return;
    notifyStatus(appCopy.library.added(moving.length, name), {
      action: { label: appCopy.library.undo, onClick: () => void undo(moving) },
    });
  } catch (error) { failed(error); }
}

async function undo(items: LibraryItem[]) {
  const byGroup = new Map<string | null, string[]>();
  for (const item of items) byGroup.set(item.group ?? null, [...(byGroup.get(item.group ?? null) ?? []), item.id]);
  try { for (const [group, ids] of byGroup) await patchItems({ ids, group }); } catch (error) { failed(error); }
}

export async function renameItem(item: LibraryItem, title: string) {
  if (title === item.title) return;
  try { syncDetail((await patchItems({ ids: [item.id], title })).items); } catch (error) { failed(error); }
}

export async function tagItems(items: LibraryItem[], addTags: string[], removeTags: string[]) {
  if (!addTags.length && !removeTags.length) return;
  try { syncDetail((await patchItems({ ids: items.map((item) => item.id), addTags, removeTags })).items); } catch (error) { failed(error); }
}

/** One line of meta: source, version (when kept in several), saved date. The version precedes the date so a narrow card truncates the date. */
export function itemMeta(item: LibraryItem) {
  const meta = documentKind(item)?.meta;
  if (meta) return meta(item);
  const host = hasWebSource(item) ? item.site ?? (item.kind === "bookmark" ? safeHost(item.url) : undefined) : undefined;
  const versions = item.revisions?.length ?? 0;
  const version = versions > 1 ? `${appCopy.artifacts.revision} ${versions}` : undefined;
  return [host, version, new Date(item.capturedAt).toLocaleDateString(document.documentElement.lang)].filter(Boolean).join(" · ");
}
/** A web source must be a non-empty, absolute HTTP(S) URL. */
export function hasWebSource(item: Pick<LibraryItem, "url">) {
  try { const url = new URL(item.url); return url.protocol === "http:" || url.protocol === "https:"; }
  catch { return false; }
}
export function safeHost(url: string) { try { return new URL(url).host; } catch { return url; } }

function syncDetail(items: LibraryItem[]) {
  const id = useLibraryNames.getState().item?.id;
  const item = items.find((item) => item.id === id);
  if (item) useLibraryNames.setState({ item });
}
