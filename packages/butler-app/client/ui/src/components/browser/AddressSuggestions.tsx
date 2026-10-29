import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { libraryChanged } from "@/app/libraryEvents";
import { deleteLibrary } from "./libraryStore";
import { historyCommand, useHistoryVersion, type AddressSuggestion } from "./historyApi";
import { Popover, PopoverAnchor, PopoverContent, Stack, SuggestionList, SuggestionRow, type AddressFieldListbox } from "@/butler-ds";

const LIST_ID = "address-suggestions";
const optionId = (index: number) => `address-suggestion-${index}`;

/** What AddressField needs to drive the list: combobox wiring, the typed text and the keys. */
export interface AddressSuggestionsField {
  listbox: AddressFieldListbox;
  onInputChange: (value: string) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** History and bookmark suggestions under the address field, exactly as wide as the field. */
export function AddressSuggestions({ editing, onChoose, field }: { editing: boolean; onChoose: (url: string) => void; field: (props: AddressSuggestionsField) => ReactNode }) {
  const [query, setQuery] = useState(""), [items, setItems] = useState<AddressSuggestion[]>([]), [index, setIndex] = useState(-1), [dismissed, setDismissed] = useState(false);
  const version = useHistoryVersion(s => s.version), anchor = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!editing) { setQuery(""); setItems([]); setIndex(-1); } }, [editing]);
  useEffect(() => {
    let active = true; setIndex(-1); setDismissed(false);
    if (!editing || !query.trim()) setItems([]);
    if (editing && query.trim()) void api<{ items: AddressSuggestion[] }>(`/browser-history/suggestions?${new URLSearchParams({ q: query })}`).then(page => { if (active) setItems(page.items); }, () => {});
    return () => { active = false; };
  }, [query, editing, version]);
  const open = editing && items.length > 0 && !dismissed;
  async function remove(item: AddressSuggestion) {
    try { if (item.bookmarkId) await deleteLibrary(item.bookmarkId); await historyCommand("delete-url", { url: item.url }); libraryChanged(); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
  }
  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) {
      event.preventDefault(); setIndex(previous => previous + step < -1 ? items.length - 1 : previous + step >= items.length ? -1 : previous + step);
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault(); onChoose(items[index]!.url);
    } else if (event.key === "Delete" && event.shiftKey && index >= 0) {
      event.preventDefault(); void remove(items[index]!);
    } else if (event.key === "Escape") { event.preventDefault(); setDismissed(true); setIndex(-1); }
  }
  const listbox = { id: LIST_ID, expanded: open, activeOptionId: index >= 0 ? optionId(index) : undefined };
  return <Stack grow><Popover open={open}><PopoverAnchor asChild><div ref={anchor}>{field({ listbox, onInputChange: setQuery, onInputKeyDown: keys })}</div></PopoverAnchor>
    <PopoverContent align="start" width="anchor" density="list" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
      onPointerDownCapture={event => event.preventDefault()}>
      <SuggestionList id={LIST_ID} label={appCopy.browser.history.suggestions}>
        {items.map((item, n) => <SuggestionRow key={item.url} id={optionId(n)} title={item.title} url={item.url} iconSrc={item.favicon || undefined}
          kind={item.bookmarkId ? "bookmark" : "history"} bookmarkLabel={appCopy.browser.bookmarked} query={query} active={n === index} onSelect={() => onChoose(item.url)} />)}
      </SuggestionList>
    </PopoverContent></Popover></Stack>;
}
