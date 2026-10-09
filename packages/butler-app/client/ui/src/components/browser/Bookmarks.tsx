import { useState } from "react";
import { Bookmark, Box, Button, ButtonContainer, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, Folder, DropdownMenuTrigger, EmptyLine, Grid, IconButton, Input, PageContainer, ScrollArea, Section, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { notifyStatus } from "@/app/notifications";
import { saveLibrary, useLibraryPage, type LibraryItem } from "./libraryStore";
import { LibraryItemCard, openLibraryItem } from "./LibraryItemCard";
import { LibraryAttachDialog } from "./LibraryAttachDialog";
function BookmarkFolder({ item, onClose }: { item?: LibraryItem; onClose: () => void }) {
  const [folder, setFolder] = useState(item?.folder ?? "");
  return <Dialog open={Boolean(item)} onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{appCopy.browser.bookmarkFolder}</DialogTitle></DialogHeader>
    <Input autoFocus aria-label={appCopy.browser.bookmarkFolder} value={folder} onChange={e => setFolder(e.target.value)} maxLength={200} />
    <DialogFooter><Button onClick={() => { if (item) void saveLibrary({ ...item, folder }).then(onClose, () => notifyStatus(appCopy.browser.failed, { tone: "error" })); }}>{appCopy.browser.ok}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
export function BookmarksMenu() {
  const [open, setOpen] = useState(false);
  return <><DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger asChild><IconButton label={appCopy.browser.bookmarks}><Bookmark size="md" /></IconButton></DropdownMenuTrigger><DropdownMenuContent align="end">
    {open && <BookmarkMenuItems />}
    <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => useButlerStore.getState().setView({ kind: "library" })}>{appCopy.browser.manageBookmarks}</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu></>;
}
function BookmarkMenuItems() {
  const page = useLibraryPage("bookmark");
  const folders = [...new Set(page.items.map(i => i.folder ?? ""))];
  const entries = (items: LibraryItem[]) => items.map(item => <DropdownMenuItem key={item.id} title={item.title} onSelect={() => void openLibraryItem(item)}><Typo.Label truncate basis="sm">{item.title}</Typo.Label></DropdownMenuItem>);
  return <>{folders.map(folder => folder ? <DropdownMenuSub key={folder}><DropdownMenuSubTrigger><Folder size="sm" />{folder}</DropdownMenuSubTrigger><DropdownMenuSubContent>{entries(page.items.filter(i => i.folder === folder))}</DropdownMenuSubContent></DropdownMenuSub> : entries(page.items.filter(i => !i.folder)))}
    {!page.loading && !page.items.length && <DropdownMenuItem disabled>{page.failed ? appCopy.browser.failed : appCopy.browser.emptyLibrary}</DropdownMenuItem>}
    {page.next_cursor && <DropdownMenuItem onSelect={e => { e.preventDefault(); page.more(); }}>{appCopy.browser.loadMore}</DropdownMenuItem>}
  </>;
}
export function NewTabPage() {
  const page = useLibraryPage("bookmark");
  const scraps = useLibraryPage("scrap");
  const [attachment, setAttachment] = useState<LibraryItem>(), [folder, setFolder] = useState<LibraryItem>();
  return <ScrollArea fill><PageContainer width="full" gutter="xl"><Box paddingY="xl"><Stack gap="xl"><Section title={appCopy.browser.bookmarks}>
    <Grid columns={{ base: "3", wide: "4" }} gap="md">{page.items.map(item => <Stack key={item.id} gap="xs">
      <LibraryItemCard item={item} onAttach={() => setAttachment(item)} />
      <ButtonContainer size="xs"><Button size="xs" variant="ghost" onClick={() => setFolder(item)}>{item.folder || appCopy.browser.bookmarkFolder}</Button></ButtonContainer>
    </Stack>)}</Grid>
    {!page.loading && !page.items.length && <EmptyLine message={page.failed ? appCopy.browser.failed : appCopy.browser.emptyLibrary} />}
    {page.next_cursor && <Button variant="ghost" disabled={page.loading} onClick={page.more}>{appCopy.browser.loadMore}</Button>}
  </Section><Section title={appCopy.browser.recentScraps} actions={<Button size="xs" variant="ghost" onClick={() => useButlerStore.getState().setView({ kind: "library" })}>{appCopy.browser.viewAll}</Button>}>
    <Grid columns="3" gap="md">{scraps.items.slice(0, 3).map(item => <LibraryItemCard key={item.id} item={item} onAttach={() => setAttachment(item)} />)}</Grid>
    {!scraps.loading && !scraps.items.length && <EmptyLine message={scraps.failed ? appCopy.browser.failed : appCopy.browser.emptyLibrary} />}
  </Section><LibraryAttachDialog item={attachment} onClose={() => setAttachment(undefined)} />
    <BookmarkFolder key={folder?.id ?? "none"} item={folder} onClose={() => setFolder(undefined)} />
  </Stack></Box></PageContainer></ScrollArea>;
}
