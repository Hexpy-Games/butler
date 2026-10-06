import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { ArrowLeft, Box, ButtonContainer, ChevronRight, Globe2, IconButton, IconSlot, Input, RefreshCcw, Square, Stack } from "@/butler-ds";
import { AgentControl } from "./AgentControl";
import { browserCall, type BrowserTab } from "./browserBridge";

export function AddressRow({ tab, enabled }: { tab?: BrowserTab; enabled: boolean }) {
  const copy = appCopy.browser;
  const [address, setAddress] = useState(tab?.url ?? "");
  const focusAddress = () => { const input = document.querySelector<HTMLInputElement>("#browser-address"); input?.focus(); input?.select(); };
  useEffect(() => setAddress(tab?.url ?? ""), [tab?.id, tab?.url]);
  useEffect(() => window.butlerBrowser?.onAddress(focusAddress), []);
  useEffect(() => { window.addEventListener("browser-focus-address", focusAddress); return () => window.removeEventListener("browser-focus-address", focusAddress); }, []);
  const call = (op: string, value?: unknown) => void browserCall(op, { id: tab?.id, value });
  return <Box paddingX="md" paddingY="xs"><Stack align="row" gap="sm" cross="center">
    <ButtonContainer size="icon-sm">
      <IconButton label={copy.back} disabled={!enabled || !tab?.canBack} onClick={() => call("back")}><ArrowLeft size="md" /></IconButton>
      <IconButton label={copy.forward} disabled={!enabled || !tab?.canForward} onClick={() => call("forward")}><ChevronRight size="md" /></IconButton>
      <IconButton label={tab?.status === "loading" ? copy.stop : copy.reload} disabled={!enabled || !tab}
        onClick={() => call(tab?.status === "loading" ? "stop" : "reload")}>{tab?.status === "loading" ? <Square size="md" /> : <RefreshCcw size="md" />}</IconButton>
    </ButtonContainer>
    <Stack align="row" gap="xs" cross="center" grow minWidth="0">
      <IconSlot tone="secondary"><Globe2 size="md" /></IconSlot>
      <Stack grow minWidth="0"><Input id="browser-address" aria-label={copy.address} placeholder={copy.addressPlaceholder}
        value={address} disabled={!enabled || !tab} onChange={(event) => setAddress(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") call("navigate", address);
          if (event.key === "Escape") { setAddress(tab?.url ?? ""); call("focus"); }
        }} /></Stack>
    </Stack>
    <AgentControl tab={tab} />
  </Stack></Box>;
}
