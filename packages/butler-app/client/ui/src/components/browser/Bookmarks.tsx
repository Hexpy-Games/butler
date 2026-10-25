import { useState } from "react";
import { Bookmark, Tag, Box, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, Folder, DropdownMenuTrigger, EmptyLine, Grid, IconButton, PageContainer, Section, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useLibraryPage, type LibraryItem } from "./libraryStore";
import { LibraryItemCard, openLibraryItem } from "./LibraryItemCard";
import { LibraryAttachDialog } from "./LibraryAttachDialog";
import { ScrapViewer } from "./ScrapViewer";
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
  const [attachment, setAttachment] = useState<LibraryItem>();
  const folders = [...new Set(page.items.map(item => item.folder ?? ""))];
  // PageCard's internal slot is the page's scroller; a ScrollArea here would bleed its scrollbar lane past the card.
  return <PageContainer width="full" gutter="xl"><Box paddingY="xl"><Stack gap="xl"><Section title={appCopy.browser.bookmarks}>
    <Stack gap="lg">{folders.map(name => <Stack key={name} gap="sm">
      {name && <Tag icon={<Folder size="xs" />} data-test-class="bookmark-folder">{name}</Tag>}
      <Grid columns={{ compact: "2", base: "3", wide: "4" }} gap="md">{page.items.filter(item => (item.folder ?? "") === name).map(item =>
        <LibraryItemCard key={item.id} item={item} onAttach={() => setAttachment(item)} view={{ kind: "library", section: "bookmark" }} />)}</Grid>
    </Stack>)}</Stack>
    {!page.loading && !page.items.length && <EmptyLine message={page.failed ? appCopy.browser.failed : appCopy.browser.emptyLibrary} />}
    {page.next_cursor && <Button variant="ghost" disabled={page.loading} onClick={page.more}>{appCopy.browser.loadMore}</Button>}
  </Section><Section title={appCopy.browser.recentScraps} actions={<Button size="xs" variant="ghost" onClick={() => useButlerStore.getState().setView({ kind: "library" })}>{appCopy.browser.viewAll}</Button>}>
    <Grid columns={{ compact: "2", base: "3", wide: "4" }} gap="md">{scraps.items.slice(0, 3).map(item => <LibraryItemCard key={item.id} item={item} view={{ kind: "library", section: "scrap" }} onAttach={() => setAttachment(item)} />)}</Grid>
    {!scraps.loading && !scraps.items.length && <EmptyLine message={scraps.failed ? appCopy.browser.failed : appCopy.browser.emptyLibrary} />}
  </Section><LibraryAttachDialog item={attachment} onClose={() => setAttachment(undefined)} />
    <ScrapViewer onSource={item => void openLibraryItem(item, true)} />
  </Stack></Box></PageContainer>;
}
