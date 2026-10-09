import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { AddressField, ArrowLeft, ArrowRight, BrowserToolbar, ButtonContainer, IconButton, RefreshCcw, Square } from "@/butler-ds";
import { AgentControl } from "./AgentControl";
import { browserCall, type BrowserTab } from "./browserBridge";

export function AddressRow({ tab, enabled }: { tab?: BrowserTab; enabled: boolean }) {
  const copy = appCopy.browser;
  const [editing, setEditing] = useState(false);
  const focusAddress = () => setEditing(true);
  useEffect(() => setEditing(Boolean(tab && !tab.url)), [tab?.id, tab?.url]);
  useEffect(() => window.butlerBrowser?.onAddress(focusAddress), []);
  useEffect(() => { window.addEventListener("browser-focus-address", focusAddress); return () => window.removeEventListener("browser-focus-address", focusAddress); }, []);
  const call = (op: string, value?: unknown) => void browserCall(op, { id: tab?.id, value });
  return <BrowserToolbar navigation={<ButtonContainer size="icon-sm">
      <IconButton label={copy.back} disabled={!enabled || !tab?.canBack} onClick={() => call("back")}><ArrowLeft size="md" /></IconButton>
      <IconButton label={copy.forward} disabled={!enabled || !tab?.canForward} onClick={() => call("forward")}><ArrowRight size="md" /></IconButton>
      <IconButton label={tab?.status === "loading" ? copy.stop : copy.reload} disabled={!enabled || !tab}
        onClick={() => call(tab?.status === "loading" ? "stop" : "reload")}>{tab?.status === "loading" ? <Square size="md" /> : <RefreshCcw size="md" />}</IconButton>
    </ButtonContainer>}
    address={<AddressField url={tab?.url} disabled={!enabled || !tab} editing={editing}
      onEditingChange={setEditing} onSubmit={(address) => call("navigate", address)}
      security={!tab?.url ? "internal" : tab.url.startsWith("https:") ? "secure" : "insecure"}
      labels={{ field: copy.address, placeholder: copy.addressPlaceholder, secure: copy.secure,
        insecure: copy.notSecure, bookmarkAdd: copy.bookmarkAdd, bookmarked: copy.bookmarked }} />}
    actions={<AgentControl tab={tab} />} />;
}
