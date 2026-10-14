import { appCopy, useAppLocale } from "@/app/copy";
import { Globe2, NavRow, Stack, Tooltip } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { openBrowser, useBrowserState } from "./browserBridge";

export function BrowserEntry() {
  useAppLocale();
  const enabled = useBrowserState((state) => state.enabled);
  const active = useButlerStore((state) => state.view.kind === "browser");
  if (!window.butlerBrowser) return null;
  return <Tooltip label={!enabled ? appCopy.browser.updateRequired : undefined}>
    <Stack><NavRow icon={<Globe2 />} label={appCopy.browser.title} active={active} disabled={!enabled}
      onClick={() => void openBrowser()} dataTestClass="browser-entry" /></Stack>
  </Tooltip>;
}
