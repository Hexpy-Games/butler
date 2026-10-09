import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { BrowserPane, Button, EmptyLine, PageCard, TabStrip, type TabStripGroup } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { activeChatFromNavigation } from "@/app/utils";
import { AddressRow } from "./AddressRow";
import { browserCall, useBrowserState } from "./browserBridge";
import { useBrowserPage } from "./useBrowserPage";
import { publicBrowserOwner } from "./browserOwnership";
import { useBrowserShellState } from "./browserShellState";

export function BrowserArea({ sessionId }: { sessionId?: string }) {
  useAppLocale();
  const state = useBrowserState();
  const navigation = useButlerStore((store) => store.navigation);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const creating = useRef(false);
  const visibleTabs = state.tabs.filter((item) => item.owner === "mine" || publicBrowserOwner(item.owner, navigation));
  const tabs = sessionId ? visibleTabs.filter((item) => item.owner === `conversation:${sessionId}`) : visibleTabs;
  const lastTab = useBrowserShellState((shell) => sessionId ? shell.conversations[sessionId]?.lastTab : undefined);
  const tab = tabs.find((item) => item.id === state.activeId) ?? tabs.find((item) => item.id === lastTab) ?? tabs[0];
  const copy = appCopy.browser;
  const { stillSrc, covered } = useBrowserPage(tab);
  useEffect(() => {
    if (tab && tab.id !== state.activeId) void browserCall("activate", { id: tab.id });
  }, [tab?.id, state.activeId]);
  useEffect(() => {
    void browserCall("scope", { value: false, owner: sessionId ? `conversation:${sessionId}` : "mine" });
  }, [sessionId]);
  useEffect(() => {
    if (sessionId || !state.enabled || tabs.length || creating.current) return;
    creating.current = true;
    void browserCall("create").finally(() => { creating.current = false; });
  }, [sessionId, state.enabled, tabs.length]);
  const groups: TabStripGroup[] = [];
  for (const item of tabs) {
    let group = groups.find((entry) => entry.id === item.owner);
    if (!group) { group = { id: item.owner, kind: item.owner === "mine" ? "mine" : "conversation", label: item.owner === "mine" ? copy.myTabs : activeChatFromNavigation(navigation, item.owner.slice(13)).shortTitle, collapsed: collapsed[item.owner], tabs: [] }; groups.push(group); }
    if (item.waiting) group.state = "waiting"; else if (item.busy) group.state ??= "working";
    if (item.status === "crashed") group.state ??= "crashed";
    group.tabs.push({ id: item.id, title: item.title, faviconSrc: item.favicon,
      state: item.busy ? "working" : item.status === "idle" ? undefined : item.status });
  }
  const call = (op: string, value?: unknown) => browserCall(op, { id: tab?.id, value });
  const create = () => void browserCall("create", sessionId ? { owner: `conversation:${sessionId}`, profile: "signed_out" } : undefined);
  const empty = !tab || !tab.url;
  const crashed = tab?.status === "crashed";
  const disabled = !state.enabled;
  return <BrowserPane placement={sessionId ? "conversation" : "standalone"} label={copy.title}
    id="butler-browser-area" data-test-class="browser-area"
    onFocusCapture={() => void browserCall("scope", { value: true })}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void browserCall("scope", { value: false });
    }} tabs={<TabStrip groups={groups} activeTabId={tab?.id ?? null} panelId="browser-page" hideChip={Boolean(sessionId)}
      labels={{ tabs: copy.title, myTabs: copy.myTabs, newTab: copy.newTab, closeTab: copy.closeTab,
        untitled: copy.newTab, loading: copy.loading, working: copy.agentControl, waiting: copy.waiting, crashed: copy.crashed,
        tabCount: (count) => copy.tabCount.replace("{count}", String(count)),
        moved: (title, group, position) => copy.tabMoved.replace("{title}", title).replace("{group}", group).replace("{position}", String(position)) }}
      onActivate={(id) => void browserCall("activate", { id })} onClose={(id) => void browserCall("close", { id })}
      onToggleGroup={(id, value) => setCollapsed((current) => ({ ...current, [id]: value }))}
      onNewTab={state.enabled ? create : undefined}
      onMove={(move) => void browserCall("move", move)} />}
    toolbar={<AddressRow tab={tab} enabled={state.enabled} />}>
    <PageCard key={tab?.id ?? "empty"} panelId="browser-page" holder="none" hidden={empty || crashed || disabled}
      viewport={tab?.agent ? { width: 1280, height: 800 } : undefined}
      stillSrc={stillSrc} covered={state.nativeCovered}
      onBoundsChange={(bounds) => { if (tab) void call("bounds", bounds); }}
      onOcclusion={(value) => { if (tab) void covered(value); }}>
      {(crashed || disabled) && <EmptyLine
        message={disabled ? (state.blocked ? copy.restartRequired : copy.updateRequired) : copy.crashed}
        action={!disabled ? <Button size="sm" variant="outline" onClick={() => void call("reload")}>{copy.reload}</Button> : undefined}
      />}
    </PageCard>
  </BrowserPane>;
}
