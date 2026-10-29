import { create } from "zustand";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { LibraryKind, LibraryView } from "@/app/types";
import type { LibraryItem } from "../browser/libraryStore";

/** Names the titlebar shows for the Library's nested levels (a group, the item in the detail panel). */
export const useLibraryNames = create<{ groups: Record<string, { name: string; kind: LibraryKind; position: number }>; item?: LibraryItem }>(() => ({ groups: {} }));

export const kindTitle = (kind: LibraryKind) => appCopy.library.kinds[kind];

/** The current level's title: 서랍 · 스크랩 · 여행 · the item. */
export function libraryTitle(view: LibraryView): string {
  if (view.item) return useLibraryNames.getState().item?.title ?? kindTitle(view.section ?? "scrap");
  if (view.section && view.group) {
    if (view.group === "none") return view.section === "bookmark" ? appCopy.library.groups.bookmark.ungrouped : appCopy.library.groups.scrap.ungrouped;
    return useLibraryNames.getState().groups[view.group]?.name ?? kindTitle(view.section);
  }
  if (view.section) return `${appCopy.library.title} › ${kindTitle(view.section)}`;
  return appCopy.library.title;
}

/** One level up: item → its group (or kind) → kind → main. The main screen has none. */
export function libraryParent(view: LibraryView): LibraryView | null {
  if (view.doc) return { kind: "library", section: "document" };
  if (view.item) return { kind: "library", section: view.section, group: view.group };
  if (view.group) return { kind: "library", section: view.section };
  if (view.section) return { kind: "library" };
  return null;
}

export function openLibrary(view: Omit<LibraryView, "kind"> = {}) {
  useButlerStore.getState().setView({ kind: "library", ...view });
}

/** Opens a scrap's detail panel (the item travels with the route; the panel reads it from here). */
export function openDetail(item: LibraryItem, from: LibraryView) {
  useLibraryNames.setState({ item });
  openLibrary({ section: item.kind === "doc" ? "document" : item.kind, group: from.group, item: item.id });
}
