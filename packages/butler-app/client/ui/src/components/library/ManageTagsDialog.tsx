import { useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyLine, Inline, Input, OverflowActionMenu, PencilLine, ScrollArea, Stack, TagIcon, Trash2, Typo } from "@/butler-ds";
import { deleteTag, renameTag, useLibraryTags, type TagCount } from "./libraryApi";
import { closeLibraryDialogs } from "./libraryDialogs";
import { setFilters, useLibraryFilters } from "./libraryFilters";

export function ManageTagsDialog({ title }: { title: string }) {
  const tags = useLibraryTags();
  return <Dialog open onOpenChange={(on) => { if (!on) closeLibraryDialogs(); }}><DialogContent>
    <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
    <ScrollArea><Stack gap="md">{tags.tags.map((tag) => <TagRow key={tag.name} tag={tag} tags={tags.tags} />)}
      {!tags.tags.length ? <EmptyLine message={tags.failed ? appCopy.library.failed : appCopy.library.noTags} /> : null}</Stack></ScrollArea>
  </DialogContent></Dialog>;
}

function TagRow({ tag, tags }: { tag: TagCount; tags: TagCount[] }) {
  const copy = appCopy.library;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name), [busy, setBusy] = useState(false);
  const target = tags.find((t) => t.name !== tag.name && t.name.normalize("NFKC").toLowerCase() === name.trim().normalize("NFKC").toLowerCase());
  const mutate = async (remove = false) => {
    setBusy(true);
    try {
      if (remove) await deleteTag(tag.name); else await renameTag(tag.name, name.trim());
      setEditing(false);
      setFilters({ tags: [...new Set(useLibraryFilters.getState().tags.flatMap((t) => t === tag.name ? remove ? [] : [target?.name ?? name.trim()] : [t]))] });
    } catch { notifyStatus(copy.failed, { tone: "error" }); }
    finally { setBusy(false); }
  };
  if (!editing) return <Inline gap="sm" cross="center" justify="between" data-library-tag={tag.name}>
    <Inline gap="sm" cross="center"><TagIcon size="sm" /><Typo.Text>{tag.name}</Typo.Text><Typo.Caption>{tag.count}</Typo.Caption></Inline>
    <OverflowActionMenu label={appCopy.browser.more} items={[
      { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => setEditing(true) },
      { icon: <Trash2 size="sm" />, label: copy.deleteTag, variant: "destructive", onSelect: () => void mutate(true) },
    ]} />
  </Inline>;
  return <Stack gap="xs" data-library-tag={tag.name}><Inline gap="sm" cross="center" wrap><Input aria-label={`${copy.name}: ${tag.name}`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
    <Typo.Caption>{tag.count}</Typo.Caption><ButtonContainer size="sm">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setName(tag.name); setEditing(false); }}>{copy.cancel}</Button>
      <Button size="sm" variant="outline" disabled={busy || !name.trim() || name === tag.name} onClick={() => void mutate()}>{target ? copy.merge : copy.rename}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(true)}>{copy.deleteTag}</Button>
    </ButtonContainer></Inline>{target ? <Typo.Caption>{copy.mergeNote(tag.name, tag.count, target.name, target.count)}</Typo.Caption> : null}</Stack>;
}
