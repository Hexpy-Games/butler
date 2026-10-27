import { useButlerStore } from "@/app/store";
import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import type { LibraryView } from "@/app/types";
import { Button, ButtonContainer, CheckIcon, IconButton, Minus, EmptyLine, Grid, Inline, Stack, Typo } from "@/butler-ds";
import type { LibraryItem } from "../browser/libraryStore";
import { LibraryItemCard } from "./LibraryItemCard";
import { GroupChips } from "./GroupChips";
import { CARD_COLUMNS } from "./LibraryMain";
import { hasGroups, useLibraryGroups, useLibraryItems } from "./libraryApi";
import { useLibraryFilters } from "./libraryFilters";
import { useLibraryDialogs } from "./libraryDialogs";

export function LibraryKindView({ view, onAttach }: { view: LibraryView; onAttach: (item: LibraryItem) => void }) {
  const kind = view.section!;
  const copy = appCopy.library;
  const filters = useLibraryFilters();
  const page = useLibraryItems({ kind, group: view.group, ...filters });
  const groups = useLibraryGroups(hasGroups(kind) ? kind : null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string>();
  const scope = JSON.stringify([kind, view.group, filters]);
  useEffect(() => { setSelected([]); setAnchor(undefined); }, [scope]);
  const items = page.items.filter((item) => selected.includes(item.id));
  const select = (item: LibraryItem, on: boolean, shift: boolean) => {
    const a = page.items.findIndex((row) => row.id === anchor), b = page.items.indexOf(item);
    const ids = shift && a >= 0 ? page.items.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.id) : [item.id];
    setSelected((prior) => on ? [...new Set([...prior, ...ids])] : prior.filter((id) => !ids.includes(id)));
    setAnchor(item.id);
  };
  return <Stack gap="lg" data-library-kind={kind}>
    {hasGroups(kind) ? <GroupChips kind={kind} groups={groups} selected={view.group} /> : null}
    {items.length ? <Inline gap="sm" wrap cross="center" justify="between" data-test-class="library-selection">
      <Inline gap="sm" cross="center"><IconButton label={copy.select} role="checkbox" aria-checked={items.length === page.items.length ? true : "mixed"}
        onClick={() => setSelected(items.length === page.items.length ? [] : page.items.map((item) => item.id))}>{items.length === page.items.length ? <CheckIcon size="sm" /> : <Minus size="sm" />}</IconButton><Typo.Text>{copy.selected(items.length)}</Typo.Text></Inline>
      <ButtonContainer size="sm">
        {hasGroups(kind) ? <Button size="sm" variant="outline" onClick={() => useLibraryDialogs.setState({ move: { kind, items } })}>{copy.groups[kind].moveTo}</Button> : null}
        <Button size="sm" variant="outline" onClick={() => useLibraryDialogs.setState({ tagItems: items })}>{copy.editTags}</Button>
        <Button size="sm" variant="ghost" onClick={() => useLibraryDialogs.setState({ deleteItems: items })}>{copy.deleteItem}</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{copy.cancel}</Button>
      </ButtonContainer>
    </Inline> : null}
    <Grid columns={CARD_COLUMNS} gap="md">{page.items.map((item) => <LibraryItemCard key={item.id} item={item} view={view} onAttach={() => onAttach(item)}
      selection={{ mode: items.length > 0, selected: selected.includes(item.id), onSelect: (on, event) => select(item, on, event.shiftKey), dragItems: () => items }} />)}</Grid>
    {!page.loading && !page.items.length ? <EmptyLine message={page.failed ? copy.failed : copy.noItems} /> : null}
    {!page.loading && !page.failed && !page.items.length && kind === "bookmark" ? <Button size="sm" variant="ghost" onClick={() => useButlerStore.getState().openSettings("browser-import")}>{appCopy.settings.pageSections.browserImport}</Button> : null}
    {page.next ? <Button variant="ghost" disabled={page.loading} onClick={page.more}>{appCopy.browser.loadMore}</Button> : null}
  </Stack>;
}
