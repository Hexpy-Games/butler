import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { AddressField, ArrowLeft, ArrowRight, BrowserToolbar, ButtonContainer, IconButton, Pick, RefreshCcw, Square } from "@/butler-ds";
import { BookmarksMenu } from "./Bookmarks";
import { saveLibrary, deleteLibrary, useBookmark } from "./libraryStore";
import { notifyStatus } from "@/app/notifications";
import { BrowserOptions } from "./BrowserOptions";
import { browserCall, type BrowserTab } from "./browserBridge";

export function AddressRow({ tab, enabled }: { tab?: BrowserTab; enabled: boolean }) {
  const bookmark = useBookmark(tab?.url);
  const copy = appCopy.browser;
  const locked = tab?.holder === "agent" && Boolean(tab.busy || tab.inUse);
  const [editing, setEditing] = useState(false);
  const focusAddress = () => setEditing(true);
  useEffect(() => setEditing(Boolean(tab && !tab.url)), [tab?.id, tab?.url]);
  useEffect(() => window.butlerBrowser?.onAddress(focusAddress), []);
  useEffect(() => { window.addEventListener("browser-focus-address", focusAddress); return () => window.removeEventListener("browser-focus-address", focusAddress); }, []);
  const call = (op: string, value?: unknown) => void browserCall(op, { id: tab?.id, value });
  return <BrowserToolbar navigation={<ButtonContainer size="icon-sm">
      <IconButton label={copy.back} disabled={locked || !enabled || !tab?.canBack} onClick={() => call("back")}><ArrowLeft size="md" /></IconButton>
      <IconButton label={copy.forward} disabled={locked || !enabled || !tab?.canForward} onClick={() => call("forward")}><ArrowRight size="md" /></IconButton>
      <IconButton label={tab?.status === "loading" ? copy.stop : copy.reload} disabled={locked || !enabled || !tab}
        onClick={() => call(tab?.status === "loading" ? "stop" : "reload")}>{tab?.status === "loading" ? <Square size="md" /> : <RefreshCcw size="md" />}</IconButton>
    </ButtonContainer>}
    address={<AddressField url={tab?.url} disabled={locked || !enabled || !tab} editing={editing}
      bookmarked={Boolean(bookmark)} onToggleBookmark={tab?.url ? () => {
        const save = bookmark ? deleteLibrary(bookmark.id) : saveLibrary({ id: crypto.randomUUID(), kind: "bookmark", title: tab.title || tab.url, url: tab.url, capturedAt: new Date().toISOString() });
        void save.catch(() => notifyStatus(copy.failed, { tone: "error" }));
      } : undefined}
      onEditingChange={setEditing} onSubmit={(address) => call("navigate", address)}
      security={!tab?.url ? "internal" : tab.url.startsWith("https:") ? "secure" : "insecure"}
      labels={{ field: copy.address, placeholder: copy.addressPlaceholder, secure: copy.secure,
        insecure: copy.notSecure, bookmarkAdd: copy.bookmarkAdd, bookmarked: copy.bookmarked }} />}
    actions={<ButtonContainer size="icon-sm"><IconButton label={copy.pick} disabled={locked || !tab?.url} aria-pressed={tab?.picking === true} onClick={() => call("pick", !tab?.picking)}><Pick size="md" /></IconButton><BookmarksMenu /><BrowserOptions tab={tab} /></ButtonContainer>} />;
}
