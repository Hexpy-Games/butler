import { useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Inline, Stack, TagField, Typo } from "@/butler-ds";
import type { LibraryItem } from "../browser/libraryStore";
import { patchItems, useLibraryTags } from "./libraryApi";
import { closeLibraryDialogs } from "./libraryDialogs";

export function ItemTagsDialog({ items }: { items: LibraryItem[] }) {
  const copy = appCopy.library, suggestions = useLibraryTags();
  const common = (items[0]?.tags ?? []).filter((tag) => items.every((item) => item.tags?.includes(tag)));
  const [value, setValue] = useState(common), [remove, setRemove] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const tags = [...new Set(items.flatMap((item) => item.tags ?? []))];
  const submit = async () => {
    setBusy(true);
    try {
      await patchItems({ ids: items.map((item) => item.id), addTags: value, removeTags: [...new Set([...remove, ...common.filter((tag) => !value.includes(tag))])] });
      closeLibraryDialogs();
    } catch { notifyStatus(copy.failed, { tone: "error" }); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(on) => { if (!on && !busy) closeLibraryDialogs(); }}><DialogContent>
    <DialogHeader><DialogTitle>{copy.bulkTagsTitle(items.length)}</DialogTitle></DialogHeader>
    <Stack gap="md"><TagField value={value} onChange={(next) => { setValue(next); setRemove((prior) => prior.filter((tag) => !next.includes(tag))); }} suggestions={suggestions.tags}
      label={copy.tags} placeholder={copy.addTag} createLabel={copy.createTag} removeLabel={copy.removeTag} />
      {items.length > 1 ? tags.filter((tag) => !common.includes(tag) && !remove.includes(tag)).map((tag) => {
        const count = items.filter((item) => item.tags?.includes(tag)).length;
        return <Inline key={tag} cross="center" gap="sm" wrap><Typo.Text>{tag}</Typo.Text><Typo.Caption>{copy.tagsOnSome(count, items.length)}</Typo.Caption>
          <ButtonContainer size="xs"><Button size="xs" variant="ghost" onClick={() => setValue((prior) => [...new Set([...prior, tag])])}>{copy.addToAll}</Button>
            <Button size="xs" variant="ghost" onClick={() => { setRemove((prior) => [...prior, tag]); setValue((prior) => prior.filter((t) => t !== tag)); }}>{copy.removeFromAll}</Button></ButtonContainer></Inline>;
      }) : null}
    </Stack><DialogFooter><ButtonContainer size="sm"><Button size="sm" variant="ghost" disabled={busy} onClick={closeLibraryDialogs}>{copy.cancel}</Button>
      <Button size="sm" disabled={busy} onClick={() => void submit()}>{copy.save}</Button></ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
