import { useMemo, useState } from "react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyLine, Input, ScrollArea, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { projectSpace } from "@/app/space/projection";
import { notifyStatus } from "@/app/notifications";
import { attachLibrary, type LibraryItem } from "./libraryStore";
export function LibraryAttachDialog({ item, onClose }: { item?: LibraryItem; onClose: () => void }) {
  const navigation = useButlerStore(s => s.navigation);
  const [query, setQuery] = useState(""), [busy, setBusy] = useState(false);
  const sessions = useMemo(() => [...projectSpace(navigation).values()].filter(row => row.session && row.node.kind === "session" && row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [navigation, query]);
  const attach = async (session: string) => {
    if (!item || busy) return; setBusy(true);
    try { await attachLibrary(session, item); onClose(); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
    finally { setBusy(false); }
  };
  return <Dialog open={Boolean(item)} onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{appCopy.browser.attachToChat}</DialogTitle></DialogHeader>
    <Input aria-label={appCopy.space.search} placeholder={appCopy.space.search} value={query} onChange={e => setQuery(e.target.value)} />
    <ScrollArea maxHeight="sm"><Stack gap="xs">
      {sessions.map(row => <Button key={row.session!.id} variant="ghost" disabled={busy} onClick={() => void attach(row.session!.id)}>{row.title}</Button>)}
      {!sessions.length && <EmptyLine message={appCopy.browser.emptyLibrary} />}
    </Stack></ScrollArea>
  </DialogContent></Dialog>;
}
