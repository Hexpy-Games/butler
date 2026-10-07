import { browserFeatureEnabled } from "@/app/productFeatures";
import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { Button, EmptyLine, NativeViewSlot, Stack, TabStrip, type TabStripGroup } from "@/butler-ds";
import { AddressRow } from "./AddressRow";
import { browserCall, connectBrowser, useBrowserState } from "./browserBridge";

export function BrowserArea() {
  useAppLocale();
  const state = useBrowserState();
  const tab = state.tabs.find((item) => item.id === state.activeId);
  const copy = appCopy.browser;
  const covering = useRef(0);
  const [still, setStill] = useState<{ id: string; src: string }>();
  useEffect(() => {
    if (tab && tab.status === "idle" && tab.url) {
      void browserCall("still", { id: tab.id }).then((src) => { if (typeof src === "string") setStill({ id: tab.id, src }); });
    }
  }, [tab?.id, tab?.status, tab?.url]);
  useEffect(() => {
    connectBrowser(); void browserCall("open");
    document.getElementById("butler-browser-area")?.focus();
    return () => { covering.current += 1; void browserCall("hide"); };
  }, []);
  const groups: TabStripGroup[] = [];
  for (const item of state.tabs) {
    let group = groups.find((entry) => entry.id === item.owner);
    if (!group) { group = { id: item.owner, kind: item.owner === "mine" ? "mine" : "conversation", label: item.owner === "mine" ? copy.myTabs : copy.output, tabs: [] }; groups.push(group); }
    group.tabs.push({ id: item.id, title: item.title, faviconSrc: item.favicon,
      state: item.status === "idle" ? undefined : item.status });
  }
  const call = (op: string, value?: unknown) => browserCall(op, { id: tab?.id, value });
  const covered = async (value: boolean) => {
    const generation = ++covering.current;
    if (value) {
      const src = await call("still");
      if (generation !== covering.current) return;
      if (typeof src === "string" && tab) setStill({ id: tab.id, src });
      // The still snapshot is painted before the native view detaches.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    if (generation === covering.current) await call("covered", value);
  };
  const empty = !tab || !tab.url;
  const crashed = tab?.status === "crashed";
  const disabled = !state.enabled;
  if (!browserFeatureEnabled) return null;
  return <Stack fill gap="none" id="butler-browser-area" tabIndex={-1} data-test-class="browser-area"
    onFocusCapture={() => void browserCall("scope", { value: true })}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void browserCall("scope", { value: false });
    }}>
    <TabStrip groups={groups} activeTabId={state.activeId} panelId="browser-page"
      labels={{ tabs: copy.title, myTabs: copy.myTabs, newTab: copy.newTab, closeTab: copy.closeTab,
        untitled: copy.newTab, loading: copy.loading, crashed: copy.crashed }}
      onActivate={(id) => void browserCall("activate", { id })} onClose={(id) => void browserCall("close", { id })}
      onNewTab={state.enabled ? () => void browserCall("create") : undefined}
      onMove={(move) => void browserCall("move", move)} />
    <AddressRow tab={tab} enabled={state.enabled} />
    <Stack fill gap="none"><NativeViewSlot key={tab?.id ?? "empty"} id="browser-page" hidden={empty || crashed || disabled}
      stillSrc={still?.id === tab?.id ? still?.src : undefined} covered={state.nativeCovered}
      onBoundsChange={(bounds) => { if (tab) void call("bounds", bounds); }}
      onOcclusion={(value) => { if (tab) void covered(value); }}>
      {(empty || crashed || disabled) && <EmptyLine
        message={disabled ? (state.blocked ? copy.restartRequired : copy.updateRequired) : crashed ? copy.crashed : copy.empty}
        action={!disabled ? <Button size="sm" variant="outline" onClick={() => {
          if (crashed) void call("reload"); else if (tab) window.dispatchEvent(new CustomEvent("browser-focus-address")); else void browserCall("create");
        }}>{crashed ? copy.reload : copy.newTab}</Button> : undefined}
      />}
    </NativeViewSlot></Stack>
  </Stack>;
}
