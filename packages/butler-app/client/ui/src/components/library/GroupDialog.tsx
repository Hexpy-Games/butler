import { useState } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, EmptyLine, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, Typo } from "@/butler-ds";
import { notifyStatus } from "@/app/notifications";
import { createGroup, deleteGroup, errorCode, patchItems, renameGroup, useLibraryGroups } from "./libraryApi";
import { closeLibraryDialogs, type LibraryDialogState } from "./libraryDialogs";
import { openLibrary } from "./libraryNav";
import { useButlerStore } from "@/app/store";

export function GroupDialog({ state }: { state: LibraryDialogState }) {
  const copy = appCopy.library;
  const kind = state.createGroup?.kind ?? state.renameGroup?.kind ?? state.ungroup?.kind ?? state.move!.kind;
  const words = copy.groups[kind], group = state.renameGroup ?? state.ungroup;
  const groups = useLibraryGroups(state.move ? kind : null);
  const [name, setName] = useState(group?.name ?? "");
  const [target, setTarget] = useState("none"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const title = state.move ? words.moveTo : state.ungroup ? words.ungroupTitle(group!.name) : state.renameGroup ? words.renameGroup : words.createGroup;
  const submit = async () => {
    setBusy(true); setError("");
    try {
      if (state.move) {
        const id = target === "__new" ? (await createGroup(kind, name.trim())).id : target === "none" ? null : target;
        await patchItems({ ids: state.move.items.map((item) => item.id), group: id });
      }
      else if (state.ungroup) {
        await deleteGroup(state.ungroup.id);
        const view = useButlerStore.getState().view;
        if (view.kind === "library" && view.group === state.ungroup.id) openLibrary({ section: kind });
      } else if (state.renameGroup) await renameGroup(state.renameGroup.id, name.trim());
      else { const created = await createGroup(kind, name.trim()); state.createGroup?.then?.(created); }
      closeLibraryDialogs();
    } catch (failure) {
      const message = errorCode(failure) === "library_group_exists" ? copy.groupExists : copy.failed;
      setError(message); notifyStatus(message, { tone: "error" });
    } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(on) => { if (!on && !busy) closeLibraryDialogs(); }}><DialogContent>
    <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
    <Stack gap="md">
      {state.ungroup ? <Typo.Text>{words.ungroupBody(group!.count)}</Typo.Text> : state.move ?
        <Stack gap="sm"><Select value={target} onValueChange={setTarget}><SelectTrigger aria-label={words.word}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="none">{words.ungrouped}</SelectItem>{groups.groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
          <SelectItem value="__new">{words.newGroup}</SelectItem>
        </SelectContent></Select>{target === "__new" ? <Input autoFocus value={name} maxLength={80} aria-label={words.groupName} onChange={(e) => setName(e.target.value)} /> : null}</Stack> :
        <Input autoFocus value={name} maxLength={80} aria-label={words.groupName} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) void submit(); }} />}
      {error ? <EmptyLine message={error} /> : null}
    </Stack>
    <DialogFooter><ButtonContainer size="sm"><Button size="sm" variant="ghost" disabled={busy} onClick={closeLibraryDialogs}>{copy.cancel}</Button>
      <Button size="sm" disabled={busy || ((!state.move && !state.ungroup || target === "__new") && !name.trim())} onClick={() => void submit()}>{state.move ? copy.move : state.ungroup ? words.ungroup : state.renameGroup ? copy.save : copy.create}</Button>
    </ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
