import { useEffect, useState } from "react";
import { appCopy, setAppCopyLanguage, useAppLocale } from "@/app/copy";
import { IconButton, PageCard, PopupWindowChrome, XIcon } from "@/butler-ds";
import { BrowserDialog, type PageDialog } from "./BrowserDialog";

interface PopupState {
  id: string; url: string; parentTitle?: string; locale?: string; theme?: string;
  platform?: "darwin" | "win32" | "linux" | "browser"; dialog?: PageDialog; still?: string;
}
declare global { interface Window { butlerPopup?: {
  call: (op: string, input?: unknown) => Promise<unknown>;
  subscribe: (handler: (state: PopupState) => void) => () => void;
} } }
export function PopupPage() {
  useAppLocale();
  const [state, setState] = useState<PopupState>();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => window.butlerPopup?.subscribe((next) => {
    setState(next);
    setAppCopyLanguage(next.locale?.startsWith("en") ? "en" : "ko");
    document.body.classList.toggle("theme-dark", next.theme === "dark");
    document.body.classList.toggle("theme-light", next.theme !== "dark");
  }), []);
  const copy = appCopy.browser;
  let host = "";
  try { host = new URL(state?.url ?? "").host; } catch { /* about:blank is untitled. */ }
  return <PopupWindowChrome host={`${host}${state?.parentTitle ? ` · ${state.parentTitle}` : ""}`} secure={state?.url.startsWith("https:")}
    securityLabel={state?.url.startsWith("https:") ? copy.secure : copy.notSecure} platform={state?.platform ?? "browser"}
    windowControls={<IconButton label={copy.closeTab} onClick={() => void window.butlerPopup?.call("close")}><XIcon /></IconButton>}>
    <PageCard contentRef={setContainer} holder="none" stillSrc={state?.still} covered={Boolean(state?.dialog)}
      onBoundsChange={(bounds) => { void window.butlerPopup?.call("bounds", bounds); }}
      onOcclusion={(value) => { void window.butlerPopup?.call("covered", value); }}
      overlay={state?.dialog && <BrowserDialog key={state.dialog.id} tab={{ id: state.id, dialog: state.dialog }} container={container}
        answer={(input) => window.butlerPopup!.call("dialog", input)} />} />
  </PopupWindowChrome>;
}
