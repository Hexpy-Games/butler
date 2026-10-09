import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { Box, Button, EmptyLine, Grid, Input, PageContainer, ScrollArea, Section, Stack } from "@/butler-ds";
import { LibraryItemCard } from "./LibraryItemCard";
import { LibraryAttachDialog } from "./LibraryAttachDialog";
import { useLibraryPage, type LibraryItem, type LibraryKind } from "./libraryStore";
function LibrarySection({ kind, query, onAttach }: { kind: LibraryKind; query: string; onAttach: (item: LibraryItem) => void }) {
  const page = useLibraryPage(kind, query);
  const copy = appCopy.browser;
  const title = { scrap: copy.scraps, document: copy.documents, bookmark: copy.bookmarks, output: copy.outputs }[kind];
  return <Section title={title} data-library-kind={kind}>
    <Grid columns={{ base: "3", wide: "4" }} gap="md">{page.items.map(item => <LibraryItemCard key={item.id} item={item} onAttach={() => onAttach(item)} />)}</Grid>
    {!page.loading && !page.items.length && <EmptyLine message={page.failed ? copy.failed : copy.emptyLibrary} />}
    {page.next_cursor && <Button variant="ghost" disabled={page.loading} onClick={page.more}>{copy.loadMore}</Button>}
  </Section>;
}
export function LibraryPage() {
  useAppLocale();
  const [text, setText] = useState(""), [query, setQuery] = useState("");
  const [attachment, setAttachment] = useState<LibraryItem>();
  useEffect(() => { const timer = setTimeout(() => setQuery(text), 150); return () => clearTimeout(timer); }, [text]);
  return <ScrollArea fill dataTestClass="library-page"><PageContainer width="full" gutter="xl"><Box paddingY="xl"><Stack gap="xl">
    <Input value={text} onChange={event => setText(event.target.value)} aria-label={appCopy.browser.librarySearch} placeholder={appCopy.browser.librarySearch} />
    {(["scrap", "document", "bookmark", "output"] as const).map(kind => <LibrarySection key={kind} kind={kind} query={query} onAttach={setAttachment} />)}
    <LibraryAttachDialog item={attachment} onClose={() => setAttachment(undefined)} />
  </Stack></Box></PageContainer></ScrollArea>;
}
