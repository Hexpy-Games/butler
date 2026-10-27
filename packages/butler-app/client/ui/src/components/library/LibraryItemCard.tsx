import { documentKind } from "./documentKinds";
import { BlockScrap } from "./BlockScrap";
import { useRef, useState, type MouseEvent } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import type { LibraryView } from "@/app/types";
import { Box, Folder, LibraryCard, MessageSquarePlus, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton, MoreHorizontal, PencilLine, Popup, TagIcon, Trash2 } from "@/butler-ds";
import { deleteLibrary, type LibraryItem } from "../browser/libraryStore";
import { openLibraryItem } from "../browser/LibraryItemCard";
import { hasGroups } from "./libraryApi";
import { hasWebSource, itemMeta, renameItem } from "./libraryActions";
import { startCardDrag, useCardDrag } from "./libraryCardDrag";
import { useLibraryDialogs } from "./libraryDialogs";
import { openDetail } from "./libraryNav";

const KIND_TAG = () => ({ scrap: appCopy.browser.element, document: appCopy.browser.document, doc: appCopy.browser.document, bookmark: appCopy.browser.bookmarks, output: appCopy.browser.output });

export interface CardSelection {
  mode: boolean;
  selected: boolean;
  onSelect: (selected: boolean, event: MouseEvent) => void;
  /** The cards a drag of this one carries (the selection when this card is in it). */
  dragItems: () => LibraryItem[];
}

/** One saved item: open (a scrap opens its detail panel), rename in place, file, tag, attach, open source, delete, drag. */
export function LibraryItemCard({ item, view, selection, onAttach }: { item: LibraryItem; view: LibraryView; selection?: CardSelection; onAttach: () => void }) {
  const copy = appCopy.library;
  const renaming = useRef(false);
  const [editing, setEditing] = useState(false);
  const dragging = useCardDrag((s) => s.items.some((dragged) => dragged.id === item.id));
  const kind = item.kind;
  const open = (event: MouseEvent) => {
    if ((event.metaKey || event.ctrlKey || event.shiftKey) && selection) { selection.onSelect(!selection.selected, event); return; }
    if (kind === "scrap") openDetail(item, view); else void openLibraryItem(item);
  };
  const remove = () => void deleteLibrary(item.id).catch(() => notifyStatus(copy.failed, { tone: "error" }));
  const items = [
    { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => { renaming.current = true; setEditing(true); } },
    ...(hasGroups(kind) ? [{ icon: <Folder size="sm" />, label: `${copy.groups[kind].moveTo}…`, onSelect: () => useLibraryDialogs.setState({ move: { kind, items: [item] } }) }] : []),
    { icon: <TagIcon size="sm" />, label: copy.editTags, onSelect: () => useLibraryDialogs.setState({ tagItems: [item] }) },
    { icon: <MessageSquarePlus size="sm" />, label: appCopy.browser.attach, onSelect: onAttach },
    ...(item.block || documentKind(item) || item.file || item.output || hasWebSource(item) ? [{ icon: <Popup size="sm" />, label: appCopy.browser.openSource, onSelect: () => void openLibraryItem(item, true) }] : []),
    { icon: <Trash2 size="sm" />, label: copy.deleteItem, variant: "destructive" as const, onSelect: remove },
  ];
  return (
    <Box data-library-item={item.id} data-butler-link={hasWebSource(item) ? item.url : undefined}><LibraryCard title={item.title} tag={item.block ? appCopy.conversation.answerBlocks.block : KIND_TAG()[kind]} meta={itemMeta(item)} tags={item.tags ?? []}
      media={documentKind(item)?.media ?? (item.block ? { kind: "block", content: <BlockScrap item={item} preview /> } : item.crop ? { kind: "image", src: item.crop } : kind === "bookmark" ? { kind: "quote", text: itemMeta(item).split(" · ")[0] ?? item.url } : { kind: "document" })}
      onOpen={open} selected={selection?.selected} selectionMode={selection?.mode} selectLabel={selection ? copy.select : undefined}
      onSelectedChange={selection?.onSelect} dragging={dragging}
      onDragPointerDown={(event) => startCardDrag(event, () => selection?.selected ? selection.dragItems() : [item])}
      editing={editing ? { value: item.title, label: copy.name, onCommit: (title) => { setEditing(false); void renameItem(item, title); }, onCancel: () => setEditing(false) } : undefined}
      menu={<DropdownMenu><DropdownMenuTrigger asChild><IconButton label={appCopy.browser.more}><MoreHorizontal size="sm" /></IconButton></DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(event) => { if (renaming.current) { event.preventDefault(); renaming.current = false; } }}>
          {items.map((action) => <DropdownMenuItem key={action.label} variant={"variant" in action ? action.variant : undefined} onSelect={action.onSelect}>{action.icon}{action.label}</DropdownMenuItem>)}
        </DropdownMenuContent></DropdownMenu>} /></Box>
  );
}
