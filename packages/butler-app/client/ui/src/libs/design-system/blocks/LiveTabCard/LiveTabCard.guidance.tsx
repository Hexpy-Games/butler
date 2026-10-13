import type { ShowcaseGuidance } from "../../showcase";
import { MediaFrame } from "../../components/MediaFrame";
import { LiveTabCard } from "./LiveTabCard";
import { LIVE_PAGES } from "./fixtures";
import { LiveTabFrame } from "./LiveTabFrame";
import { demoCard } from "./liveTabDemo";

// #region recipe: A tab Butler is using
function BusyTab() {
  return (
    <LiveTabCard title="Pine Grove Campground · Booking" frame={LIVE_PAGES.booking} state="busy" stateLabel="Butler is browsing"
      onOpen={() => undefined} onClose={() => undefined} closeLabel="Close tab" />
  );
}
// #endregion

// #region recipe: A hand-off that needs the user
function HandoffTab() {
  return (
    <LiveTabCard title="Riverside Campground · Site map" frame={LIVE_PAGES.sitesSignIn} state="attention" stateLabel="Needs you"
      needsYou={{ detail: "Two-step verification", action: { label: "Open to check", onAction: () => undefined } }}
      onOpen={() => undefined} onClose={() => undefined} closeLabel="Close tab" />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A live preview of one Butler browser tab: title row, a 16:10 frame drawn from a passed bitmap or picture, and the tab's state.",
  whenToUse: [
    "Butler's tabs beside the conversation (inside TabRail, which picks the variant)",
    "A page thumbnail that must show the live frame of a tab (LiveTabFrame, e.g. the approval panel's media)",
  ],
  whenNotToUse: [
    { when: "History of what Butler did (step stills)", use: "WorkActivityBlock" },
    { when: "The user's own open tabs", use: "TabStrip" },
    { when: "A saved page or scrap", use: "LibraryCard" },
    { when: "A static picture with no tab behind it", use: "MediaFrame" },
  ],
  recipes: [
    { name: "A tab Butler is using", description: "The thinking mark and a faint ink ring; the body opens the tab, × closes it.", render: () => <BusyTab /> },
    { name: "A hand-off that needs the user", description: "Amber ring, the state tag and the needs-you band whose action opens the tab for the user.", render: () => <HandoffTab /> },
  ],
  doDont: [
    {
      do: { caption: "Pass the tab's live frame; frames swap with no crossfade.", render: () => <LiveTabCard {...demoCard("en-US", "busy")} /> },
      dont: { caption: "A plain picture frame loses the state, the title and the close action.", render: () => <MediaFrame src={LIVE_PAGES.booking} /> },
    },
    {
      do: { caption: "Before the first frame, the favicon sits on the matte.", render: () => <LiveTabFrame favicon={demoCard("en-US", "idle").favicon} /> },
      dont: { caption: "Do not show a stale still from another tab as a placeholder.", render: () => <LiveTabFrame frame={LIVE_PAGES.reviews} /> },
    },
  ],
  content: [
    "Title: the page title. Chip label (shortTitle): the site name.",
    "State words come from butler-i18n browser.*: 버틀러가 조작 중 (agentUsing), 직접 조작 중 (userControl), 승인 대기 (waiting), 확인 필요 (rail.needsCheck), 오류 (rail.error).",
    "The needs-you action is 열어서 확인 / Open to check (rail.openToCheck); the error overlay is 페이지 오류 / 새로고침.",
  ],
  accessibility: [
    "The body is one Clickable named by the title and the state; × is a separate IconButton beside it, never nested.",
    "Compact thumbnails show the title as a tooltip and keep it as the accessible name.",
    "Frames are decorative (aria-hidden); they are never interactive.",
    "The thinking mark stops under reduced motion.",
  ],
  tokens: ["--tab-rail-width", "--tab-rail-compact-width", "--browser-card-shadow", "--butler-ink-purple", "--color-warning", "--color-warning-bg", "--color-danger-border", "--favicon-plate", "--radius-panel"],
};
