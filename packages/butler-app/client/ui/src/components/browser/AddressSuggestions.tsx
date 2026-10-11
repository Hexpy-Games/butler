import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { libraryChanged } from "@/app/libraryEvents";
import { deleteLibrary } from "./libraryStore";
import { historyCommand, useHistoryVersion, type AddressSuggestion } from "./historyApi";
import { NavRow, Popover, PopoverAnchor, PopoverContent, Stack, Typo } from "@/butler-ds";

/** Compose around AddressField; capture its input without changing the DS. */
export function AddressSuggestions({ editing, onChoose, children }: { editing: boolean; onChoose: (url: string) => void; children: ReactNode }) {
  const [query, setQuery] = useState(""), [items, setItems] = useState<AddressSuggestion[]>([]), [index, setIndex] = useState(-1);
  const version = useHistoryVersion(s => s.version), anchor = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!editing) { setQuery(""); setItems([]); setIndex(-1); } }, [editing]);
  useEffect(() => {
    let active = true; setItems([]); setIndex(-1);
    if (editing && query.trim()) void api<{ items: AddressSuggestion[] }>(`/browser-history/suggestions?${new URLSearchParams({ q: query })}`).then(page => { if (active) setItems(page.items); }, () => {});
    return () => { active = false; };
  }, [query, editing, version]);
  async function remove(item: AddressSuggestion) {
    try { if (item.bookmarkId) await deleteLibrary(item.bookmarkId); await historyCommand("delete-url", { url: item.url }); libraryChanged(); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (!editing || !items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation(); setIndex(previous => previous < 0 ? event.key === "ArrowDown" ? 0 : items.length - 1 : (previous + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault(); event.stopPropagation(); onChoose(items[index]!.url);
    } else if (event.key === "Delete" && event.shiftKey && index >= 0) {
      event.preventDefault(); event.stopPropagation(); void remove(items[index]!);
    } else if (event.key === "Escape") { setItems([]); }
  }
  useEffect(() => {
    const input = anchor.current?.querySelector("input");
    if (!input) return;
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", String(items.length > 0)); input.setAttribute("aria-controls", "address-suggestions");
    if (index >= 0) input.setAttribute("aria-activedescendant", `address-suggestion-${index}`); else input.removeAttribute("aria-activedescendant");
  }, [editing, items, index]);
  return <Stack grow><Popover open={editing && items.length > 0}><PopoverAnchor asChild><div ref={anchor} onKeyDownCapture={keys}
    onInputCapture={event => { if (event.target instanceof HTMLInputElement) setQuery(event.target.value); }}>{children}</div></PopoverAnchor>
    <PopoverContent align="start" width="default" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
      onPointerDownCapture={event => event.preventDefault()}>
      <Stack id="address-suggestions" role="listbox" aria-label={appCopy.browser.history.suggestions} gap="xs">
        {items.map((item, n) => <Stack id={`address-suggestion-${n}`} key={item.url} role="option" aria-selected={n === index}>
          <NavRow active={n === index} label={item.title || item.url} meta={<Typo.Caption truncate tone="secondary">{item.url}</Typo.Caption>} onClick={() => onChoose(item.url)} />
        </Stack>)}
      </Stack>
    </PopoverContent></Popover></Stack>;
}
