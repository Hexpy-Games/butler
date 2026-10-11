import { appCopy, useAppLocale } from "@/app/copy";
import { useLibraryDialogs } from "./libraryDialogs";
import { GroupDialog } from "./GroupDialog";
import { ItemTagsDialog } from "./ItemTagsDialog";
import { ManageTagsDialog } from "./ManageTagsDialog";
import { SavedGroupChooser } from "./SavedGroupChooser";
import { DeleteItemsDialog } from "./DeleteItemsDialog";

/** Mounted by the App, so picks can be filed while the browser stays open. */
export function LibraryDialogHost() {
  useAppLocale();
  const state = useLibraryDialogs();
  return <>
    {state.createGroup || state.renameGroup || state.ungroup || state.move ? <GroupDialog key={state.renameGroup?.id ?? state.ungroup?.id ?? state.move?.items.map((i) => i.id).join(",") ?? "create"} state={state} /> : null}
    {state.tagItems ? <ItemTagsDialog key={state.tagItems.map((i) => i.id).join(",")} items={state.tagItems} /> : null}
    {state.deleteItems ? <DeleteItemsDialog items={state.deleteItems} /> : null}
    {state.tags ? <ManageTagsDialog title={appCopy.library.manageTags} /> : null}
    {state.saved ? <SavedGroupChooser key={state.saved.ids.join(",")} saved={state.saved} /> : null}
  </>;
}
