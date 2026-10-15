import { useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/butler-ds";
import { deleteLibrary, type LibraryItem } from "../browser/libraryStore";
import { closeLibraryDialogs } from "./libraryDialogs";

export function DeleteItemsDialog({ items }: { items: LibraryItem[] }) {
  const copy = appCopy.library;
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try { for (const item of items) await deleteLibrary(item.id); closeLibraryDialogs(); }
    catch { notifyStatus(copy.failed, { tone: "error" }); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(on) => { if (!on && !busy) closeLibraryDialogs(); }}><DialogContent>
    <DialogHeader><DialogTitle>{copy.deleteSelected(items.length)}</DialogTitle><DialogDescription>{copy.deleteSelectedBody}</DialogDescription></DialogHeader>
    <DialogFooter><ButtonContainer size="sm"><Button size="sm" variant="ghost" disabled={busy} onClick={closeLibraryDialogs}>{copy.cancel}</Button>
      <Button size="sm" disabled={busy} onClick={() => void remove()}>{copy.deleteItem}</Button></ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
