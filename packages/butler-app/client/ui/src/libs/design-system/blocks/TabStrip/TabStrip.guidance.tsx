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
  purpose: "The Browser area's tab row: closable, reorderable pill tabs grouped as my tabs plus one muted, foldable outline pill per conversation. A tab's close button shows on hover or keyboard focus.",
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
    { name: "Browser tabs from App state", description: "Groups, active id and every intent live in the container; apply moves with applyTabStripMove. onNewTabInGroup gives each pill its own +.", render: () => <BrowserTabs /> },
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
    "Group labels are the conversation title. Pass Korean labels (내 탭, 새 탭, 탭 닫기, 승인 대기, {group}에 새 탭) from the App copy.",
    "Beside other groups each group is one outline pill (border, no fill): title, tabs, then its own + (onNewTabInGroup), and the row's + goes away. Only the selected tab is filled; thin dividers sit between tabs and after the title and step aside next to a filled tab.",
    "A click on the title folds the group (no chevron): the tabs slide closed and the title previews up to three favicons and +N. With only my tabs, the strip shows plain pill tabs and the row's +.",
    "Group state is one of working, waiting for approval or crashed: no extra text in the strip.",
    "A tab that is not a web page (a file in a docked viewer) passes its own icon, such as FileText or ImageIcon at size md; it takes the favicon slot instead of the globe, and loading, working or crashed still replace it.",
    "hideChip: a conversation's own browser pane shows its one group without the title or outline (the title bar names it) and at full strength, with the row's +; trailing holds row-end controls such as Bring in a tab.",
  ],
  accessibility: [
    "Each open group is a role=tablist named by its label; tabs are role=tab with aria-selected and aria-controls (panelId).",
    "One tab stop: arrows move across group titles, tabs and each open pill's + (wrapping), Home/End jump, Enter/Space activate, Delete/Backspace close.",
    "Cmd/Ctrl+Shift+Left/Right moves the focused tab, also into the neighbor group; moves are announced politely.",
    "Group titles are buttons with aria-expanded; their names include the tab count and the group state. The tooltip shows the full, untruncated label. A folded group's tabs are inert and out of the arrow order.",
    "Folding slides on --motion-base and is instant under reduced motion. Focus rings keep --focus-ring-room inside the pill and the fold's clip.",
    "The close button shows only while its tab is hovered or has keyboard focus, the selected tab included. It keeps its slot (titles never reflow), fades on --motion-fast and appears at once under reduced motion.",
    "Touch layouts (hover: none) show the close button on the selected tab only. Middle-click, Delete/Backspace and Cmd/Ctrl+W close any tab.",
  ],
  tokens: [
    "--tab-strip-tab-min-width", "--tab-strip-tab-max-width", "--tab-strip-chip-max-width", "--selection-strong", "--radius-pill", "--line",
    "--border-hairline", "--focus-ring-room",
    "--control-height-md", "--scroll-fade-size", "--motion-base", "--motion-fast", "--color-warning-text", "--color-danger-text",
  ],
};
