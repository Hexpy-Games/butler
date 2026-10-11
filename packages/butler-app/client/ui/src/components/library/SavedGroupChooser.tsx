import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Popover, PopoverAnchor, PopoverContent, ScrollArea, Stack, Typo } from "@/butler-ds";
import { browserCall } from "../browser/browserBridge";
import { patchItems, useLibraryGroups } from "./libraryApi";
import { closeLibraryDialogs, useLibraryDialogs } from "./libraryDialogs";

export function SavedGroupChooser({ saved }: { saved: { ids: string[]; beside: boolean } }) {
  const copy = appCopy.library;
  const groups = useLibraryGroups("scrap");
  const [busy, setBusy] = useState(false);
  const defaultChoice = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { defaultChoice.current?.focus(); void browserCall("focus-app"); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const anchor = useRef({ getBoundingClientRect: () => document.querySelector('[data-test-class="library-entry"]')?.getBoundingClientRect() ?? new DOMRect() });
  const choose = async (group: string) => {
    setBusy(true);
    try { await patchItems({ ids: saved.ids, group }); closeLibraryDialogs(); }
    catch { notifyStatus(copy.failed, { tone: "error" }); }
    finally { setBusy(false); }
  };
  const contents = <Stack gap="sm" data-test-class="library-saved-chooser">
    <Typo.Text>{copy.savedScraps(saved.ids.length)}</Typo.Text>
    <Button ref={defaultChoice} autoFocus variant="ghost" disabled={busy} onKeyDown={(event) => { if (event.key === "Enter" && !busy) { event.preventDefault(); closeLibraryDialogs(); } }} onClick={closeLibraryDialogs}>{copy.leaveUngrouped}</Button>
    <ScrollArea><Stack gap="xs">{groups.groups.map((group) => <Button key={group.id} variant="ghost" disabled={busy} onClick={() => void choose(group.id)}>{group.name}</Button>)}</Stack></ScrollArea>
    <Button variant="ghost" disabled={busy} onClick={() => useLibraryDialogs.setState({ saved: undefined, createGroup: { kind: "scrap", then: (group) => void choose(group.id) } })}>{copy.groups.scrap.newGroup}</Button>
  </Stack>;
  const dismiss = (on: boolean) => { if (!on && !busy) closeLibraryDialogs(); };
  if (saved.beside) return <Popover open onOpenChange={dismiss}><PopoverAnchor virtualRef={anchor} /><PopoverContent side="right" align="start"
    onOpenAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-test-class="library-saved-chooser"] button')?.focus(); }}>{contents}</PopoverContent></Popover>;
  return <Dialog open onOpenChange={dismiss}><DialogContent><DialogHeader><DialogTitle>{copy.addToGroup}</DialogTitle></DialogHeader>{contents}</DialogContent></Dialog>;
}
