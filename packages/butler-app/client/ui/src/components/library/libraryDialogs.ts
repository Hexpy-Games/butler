import { create } from "zustand";
import type { LibraryItem } from "../browser/libraryStore";
import type { GroupKind, LibraryGroup } from "./libraryApi";

/** The Library's dialogs; one host (LibraryDialogs) renders whichever is open, from any screen. */
export interface LibraryDialogState {
  /** Tag management. */
  tags?: boolean;
  createGroup?: { kind: GroupKind; then?: (group: LibraryGroup) => void };
  renameGroup?: LibraryGroup;
  ungroup?: LibraryGroup;
  /** Move items into a group of their kind. */
  move?: { kind: GroupKind; items: LibraryItem[] };
  /** Tags of one item, or of several (bulk). */
  tagItems?: LibraryItem[];
  deleteItems?: LibraryItem[];
  /** Scraps just saved from the browser: put them in a group (shown beside the sidebar's 서랍 row). */
  saved?: { ids: string[]; beside: boolean };
}
export const useLibraryDialogs = create<LibraryDialogState>(() => ({}));
export const closeLibraryDialogs = () => useLibraryDialogs.setState({ tags: undefined, createGroup: undefined, renameGroup: undefined, ungroup: undefined, move: undefined, tagItems: undefined, deleteItems: undefined, saved: undefined });
