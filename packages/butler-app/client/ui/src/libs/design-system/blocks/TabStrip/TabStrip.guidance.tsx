import type { ShowcaseGuidance } from "../../showcase";
import { Tabs, TabsList, TabsTrigger } from "../../components/Tabs";
import { TabStrip } from "./TabStrip";
import { demoGroups, ICONS, TabStripDemo } from "./TabStrip.demo";

const noop = () => undefined;

// #region recipe: Browser tabs from App state
function BrowserTabs() {
  // The container owns tab state and maps Electron tabs to groups; the strip only reports intents.
  return <TabStripDemo locale="en-US" initial={demoGroups("en-US")} panelId="browser-page" />;
}
// #endregion

// #region recipe: Read-only tab row
function ReadOnlyTabs() {
  return (
    <TabStrip activeTabId="a" onActivate={noop} onClose={noop}
      groups={[{ id: "mine", kind: "mine", tabs: [{ id: "a", title: "Butler design system", faviconSrc: ICONS.docs }, { id: "b", title: "Inbox", faviconSrc: ICONS.mail }] }]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The Browser area's tab row: closable, reorderable tabs grouped as my tabs plus one muted, foldable group per conversation.",
  whenToUse: [
    "Browser tabs over a page area (pair with NativeViewSlot)",
    "Tabs the user and conversations open, grouped by owner",
  ],
  whenNotToUse: [
    { when: "Switching peer views inside one panel", use: "Tabs" },
    { when: "Sidebar navigation between conversations", use: "NavRow" },
    { when: "Reordering settings cards", use: "SortableCardList" },
  ],
  recipes: [
    { name: "Browser tabs from App state", description: "Groups, active id and every intent live in the container; apply moves with applyTabStripMove.", render: () => <BrowserTabs /> },
    { name: "Read-only tab row", description: "Without onMove, onToggleGroup or onNewTab the order is locked and no new-tab button shows.", render: () => <ReadOnlyTabs /> },
  ],
  doDont: [
    {
      do: { caption: "Use TabStrip for page tabs: they close, shrink, scroll and carry favicons.", render: () => <ReadOnlyTabs /> },
      dont: {
        caption: "Do not fake browser tabs with view Tabs; they cannot close, reorder or group.",
        render: () => <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">Butler design system</TabsTrigger><TabsTrigger value="b">Inbox</TabsTrigger></TabsList></Tabs>,
      },
    },
  ],
  content: [
    "Tab titles come from the page; the strip truncates them. An empty title reads the untitled label.",
    "Group labels are the conversation title. Pass Korean labels (내 탭, 새 탭, 탭 닫기, 승인 대기) from the App copy.",
    "Group state is one of working, waiting for approval or crashed: no extra text in the strip.",
  ],
  accessibility: [
    "Each open group is a role=tablist named by its label; tabs are role=tab with aria-selected and aria-controls (panelId).",
    "One tab stop: arrows move across chips and tabs (wrapping), Home/End jump, Enter/Space activate, Delete/Backspace close.",
    "Cmd/Ctrl+Shift+Left/Right moves the focused tab, also into the neighbor group; moves are announced politely.",
    "Group chips are buttons with aria-expanded; their names include the tab count and the group state. The tooltip shows the full, untruncated label.",
  ],
  tokens: [
    "--tab-strip-tab-min-width", "--tab-strip-tab-max-width", "--tab-strip-chip-max-width", "--selection-strong",
    "--control-height-md", "--scroll-fade-size", "--motion-base", "--color-warning-text", "--color-danger-text",
  ],
};
