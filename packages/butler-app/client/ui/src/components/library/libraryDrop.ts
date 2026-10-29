import type { LibraryItem } from "../browser/libraryStore";
import { useButlerStore } from "@/app/store";
import type { AppView } from "@/app/types";
import { useLibraryDialogs } from "./libraryDialogs";
import { useLibraryNames } from "./libraryNav";

export type GroupTarget = { kind: "group"; group: string; name: string };

/** A group tile (main screen) or group chip (kind view) under the pointer that accepts items of `kind`. */
export function groupAt(hit: Element | null, kind: LibraryItem["kind"]): GroupTarget | undefined {
  const node = hit?.closest<HTMLElement>("[data-group-tile], [data-group-chip]");
  const id = node?.dataset.groupTile || node?.dataset.groupChip;
  const group = id ? useLibraryNames.getState().groups[id] : undefined;
  return group && group.kind === kind ? { kind: "group", group: id!, name: group.name } : undefined;
}

/** After scraps are saved without a group: offer the group list beside the sidebar's 서랍 row (or as a dialog). */
export function afterScrap(ids: string[]) {
  if (!ids.length) return;
  const entry = document.querySelector<HTMLElement>('[data-test-class="library-entry"]');
  const visible = Boolean(entry && entry.getBoundingClientRect().width > 0);
  useLibraryDialogs.setState({ saved: { ids, beside: visible } });
}

let before: AppView | undefined;
/** A pick rested on 서랍: open the Library main screen so it can land on a group tile; the drag carries on. */
export function beginDwell() {
  const store = useButlerStore.getState();
  if (store.view.kind === "library" && !store.view.section && !store.view.item) return;
  before = store.view;
  store.setView({ kind: "library" });
}
/** The drag ended (dropped or cancelled): go back to where it started. */
export function endDwell() {
  if (!before) return;
  const view = before;
  before = undefined;
  useButlerStore.getState().setView(view);
}
