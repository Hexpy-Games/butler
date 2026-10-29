import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { LiveTabCard } from "../LiveTabCard";
import { demoCard } from "../LiveTabCard/liveTabDemo";
import { TabRail } from "./TabRail";
import { railTabs, SET_A, Stage } from "./tabRailDemo";

// #region recipe: Butler's tabs beside the conversation
function ConversationRail() {
  return (
    <Stage height="tall">
      <TabRail mode="full" view="conversation-1" tabs={railTabs("en-US", SET_A)} onMore={() => undefined}
        labels={{ region: "Butler's tabs", close: "Close tab", more: (count) => `${count} more tabs · View in browser` }} />
    </Stage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Live previews of Butler's tabs beside the conversation: a full rail, a compact rail or a shelf strip, chosen from the conversation card's width.",
  whenToUse: [
    "Butler browses in the background and the user should see its tabs without opening the browser area",
    "The ConversationShell rail slot (the column makes room once per view)",
  ],
  whenNotToUse: [
    { when: "The browser area is open (its TabStrip lists the same tabs)", use: "TabStrip" },
    { when: "One tab's preview elsewhere (an approval)", use: "LiveTabCard" },
    { when: "What Butler did, step by step", use: "WorkActivityBlock" },
  ],
  recipes: [
    { name: "Butler's tabs beside the conversation", description: "Three cards in the owner's order, the rest behind +N; in the app pass mode auto (default) inside ConversationShell rail.", render: () => <ConversationRail /> },
  ],
  doDont: [
    {
      do: { caption: "Let the rail cap the cards and collapse the rest into +N.", render: () => <ConversationRail /> },
      dont: { caption: "Stacking every tab as a card pushes the rail past the card's height.", render: () => (
        <Stack gap="md">{SET_A.map((state) => <LiveTabCard key={state} {...demoCard("en-US", state)} />)}</Stack>
      ) },
    },
  ],
  content: [
    "Region: 버틀러의 탭 / Butler's tabs (butler-i18n browser.rail.region); +N: 탭 2개 더 · 브라우저에서 보기 (rail.more).",
    "Order: needs you (waiting, sign-in, payment, dialog), then busy, then error, then idle; newest Butler action first in a group.",
    "The × is 탭 닫기 / Close tab (browser.closeTab); closing a tab Butler uses needs no confirmation.",
  ],
  accessibility: [
    "The rail is a labelled region; each card is one button named by title and state, × a separate button.",
    "The layer around the rail takes no pointer input, so the transcript scrolls and selects under it.",
    "Reduced motion: no enter or exit motion and still thinking marks.",
    "The shelf scrolls sideways inside its strip without a scrollbar (the TabStrip rule), so a classic scrollbar never lifts the cards or cuts their focus rings; the page never scrolls horizontally.",
  ],
  tokens: ["--tab-rail-width", "--tab-rail-compact-width", "--tab-rail-shelf-height", "--control-hit-target", "--focus-ring-room", "--tab-rail-inset", "--tab-rail-clearance", "--motion-base", "--motion-fast", "--motion-distance-sm"],
};
