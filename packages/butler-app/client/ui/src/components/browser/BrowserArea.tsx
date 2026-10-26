import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { BrowserPane, Button, EmptyLine, PageCard, TabStrip, type TabStripGroup } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { activeChatFromNavigation } from "@/app/utils";
import { BrowserDialog } from "./BrowserDialog";
import { AgentControl, browserHolder } from "./AgentControl";
import { AddressRow } from "./AddressRow";
import { NewTabPage } from "./Bookmarks";
import { BringTabButton } from "./BringTabButton";
import { useBrowserTabDragHandler } from "./useBrowserTabDrag";
import { useBrowserTabDrag } from "./browserTabDrag";
import { browserCall, useBrowserState } from "./browserBridge";
import { useBrowserPage } from "./useBrowserPage";
import { publicBrowserOwner, relevantConversationTab } from "./browserOwnership";
import { useBrowserShellState } from "./browserShellState";
import { familyAgentTabs } from "./conversationAgentTabs";
import { useConversationFamily } from "./useConversationAgentTabs";

export function BrowserArea({ sessionId }: { sessionId?: string }) {
  const locale = useAppLocale();
  const reducedMotion = useButlerStore((store) => store.settings.reduce_motion);
  useEffect(() => { void browserCall("presentation", { locale, reducedMotion }); }, [locale, reducedMotion]);
  const state = useBrowserState();
  const navigation = useButlerStore((store) => store.navigation);
  // The hub shows conversation tabs by navigation; before it loads they are unknown, not absent.
  const tabsKnown = useButlerStore((store) => Boolean(sessionId) || store.navigationLoaded);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dialogContainer, setDialogContainer] = useState<HTMLDivElement | null>(null);
  const creating = useRef(false);
  const family = useConversationFamily(sessionId ?? "");
  const rolled = sessionId ? familyAgentTabs(family, state.tabs) : [];
  const visibleTabs = state.tabs.filter((item) => item.owner === "mine" || publicBrowserOwner(item.owner, navigation));
  const tabs = sessionId ? state.tabs.filter((item) => item.owner === `conversation:${sessionId}` || rolled.includes(item)) : visibleTabs;
  const lastTab = useBrowserShellState((shell) => sessionId ? shell.conversations[sessionId]?.lastTab : undefined);
  const tab = tabs.find((item) => item.id === state.activeId) ?? (sessionId ? relevantConversationTab(tabs, lastTab) : tabs[0]);
  const copy = appCopy.browser;
  const { stillSrc, covered } = useBrowserPage(tab);
  useEffect(() => {
    if (tabsKnown && tab && tab.id !== state.activeId) void browserCall("activate", { id: tab.id });
  }, [tabsKnown, tab?.id, state.activeId]);
  useEffect(() => {
    void browserCall("scope", { value: false, owner: sessionId ? `conversation:${sessionId}` : "mine" });
  }, [sessionId]);
  const paneOwner = sessionId ? `conversation:${sessionId}` : "mine";
  // Groups are keyed by their tabs' owner, so a group's + opens its tab with that owner. A tab the user
  // opens is the user's own browsing in every group: it keeps the user's sign-ins (main's default).
  const create = (owner: string, placeholder = false) => browserCall("create", { owner, placeholder });
  // Opened with no tabs, the pane opens a new tab at once (its in-app new-tab page, address focused).
  // It is a placeholder: a page that opens in or moves into the group (Butler's, a link's) takes its place.
  useEffect(() => {
    if (!state.restored || !state.enabled || !tabsKnown || tabs.length || creating.current) return;
    creating.current = true;
    void create(paneOwner, true).finally(() => { creating.current = false; });
  }, [sessionId, state.restored, state.enabled, tabsKnown, tabs.length]);
  const groups: TabStripGroup[] = [];
  for (const item of tabs) {
    let group = groups.find((entry) => entry.id === item.owner);
    if (!group) { group = { id: item.owner, kind: item.owner === "mine" ? "mine" : "conversation", label: item.owner === "mine" ? copy.myTabs : activeChatFromNavigation(navigation, sessionId ?? item.owner.slice(13)).shortTitle, collapsed: collapsed[item.owner], tabs: [] }; groups.push(group); }
    if (item.waiting) group.state = "waiting"; else if (item.busy) group.state ??= "working";
    if (item.status === "crashed") group.state ??= "crashed";
    group.tabs.push({ id: item.id, title: item.title, faviconSrc: item.favicon,
      state: item.busy ? "working" : item.status === "idle" ? undefined : item.status });
  }
  const drag = useBrowserTabDragHandler(groups.flatMap((group) => group.collapsed ? [] : group.tabs.map((item) => tabs.find((tab) => tab.id === item.id)!)));
  const call = (op: string, value?: unknown) => browserCall(op, { id: tab?.id, value });
  const empty = !tab || !tab.url;
  const crashed = tab?.status === "crashed";
  const disabled = !state.enabled;
  return <BrowserPane placement={sessionId ? "conversation" : "standalone"} label={copy.title}
    id="butler-browser-area" data-test-class="browser-area"
    onFocusCapture={() => void browserCall("scope", { value: true })}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void browserCall("scope", { value: false });
    }} tabs={<TabStrip groups={groups} activeTabId={tab?.id ?? null} panelId="browser-page" hideChip={Boolean(sessionId)}
      onPointerDownCapture={drag} onKeyDownCapture={() => {
        // Modifier keys during a pointer drag must retain the outside-drop guard.
        if (!useBrowserTabDrag.getState().tabId) useBrowserTabDrag.setState({ outside: false });
      }} trailing={sessionId ? <BringTabButton sessionId={sessionId} /> : undefined}
      labels={{ tabs: copy.title, myTabs: copy.myTabs, newTab: copy.newTab, closeTab: copy.closeTab,
        untitled: copy.newTab, loading: copy.loading, working: copy.agentControl, waiting: copy.waiting, crashed: copy.crashed,
        tabCount: (count) => copy.tabCount.replace("{count}", String(count)),
        newTabIn: (group) => copy.newTabIn.replace("{group}", group), moreTabs: (count) => copy.moreTabs.replace("{count}", String(count)),
        moved: (title, group, position) => copy.tabMoved.replace("{title}", title).replace("{group}", group).replace("{position}", String(position)) }}
      onActivate={(id) => void browserCall("activate", { id })} onClose={(id) => void browserCall("close", { id })}
      onToggleGroup={(id, value) => setCollapsed((current) => ({ ...current, [id]: value }))}
      onNewTab={state.enabled ? () => void create(paneOwner) : undefined}
      onNewTabInGroup={!sessionId && state.enabled ? (groupId) => void create(groupId) : undefined}
      onMove={(move) => { if (!useBrowserTabDrag.getState().outside) void browserCall("move", move); }} />}
    toolbar={<AddressRow tab={tab} enabled={state.enabled} />}>
    <PageCard key={tab?.id ?? "empty"} panelId="browser-page" holder={browserHolder(tab)} hidden={empty || crashed || disabled}
      internal={empty && !disabled ? <NewTabPage /> : undefined}
      occluderSelector='[data-slot="nav-drop-label"]'
      viewport={tab?.agent ? { width: 1280, height: 800 } : undefined}
      stillSrc={stillSrc} covered={state.nativeCovered || Boolean(tab?.dialog)} contentRef={setDialogContainer}
      band={<AgentControl tab={tab} />} reserveBand
      overlay={tab?.dialog && <BrowserDialog key={tab.dialog.id} tab={tab} container={dialogContainer} />}
      onBoundsChange={(bounds) => { if (tab) void call("bounds", bounds); }}
      onOcclusion={(value) => { if (tab) void covered(value); }}>
      {(crashed || disabled) && <EmptyLine
        message={disabled ? (state.blocked ? copy.restartRequired : copy.updateRequired) : copy.crashed}
        action={!disabled ? <Button size="sm" variant="outline" onClick={() => void call("reload")}>{copy.reload}</Button> : undefined}
      />}
    </PageCard>
  </BrowserPane>;
}
