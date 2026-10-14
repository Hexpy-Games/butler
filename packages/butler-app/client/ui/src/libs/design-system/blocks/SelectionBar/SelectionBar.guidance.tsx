import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { MessageSquarePlus, Scrap } from "../../components/Icons";
import { SelectionBar } from "./SelectionBar";

// #region recipe: Two picks
function TwoPicks() {
  return (
    <SelectionBar placement="inline" count={2} label="2 selected" clearLabel="Clear" onClear={() => undefined} actions={[
      { id: "attach", label: "Add to chat", icon: <MessageSquarePlus size="sm" />, onSelect: () => undefined },
      { id: "scrap", label: "Scrap", icon: <Scrap size="sm" />, onSelect: () => undefined },
    ]} />
  );
}
// #endregion

// #region recipe: Pick mode just started
function PickingStarted() {
  return (
    <SelectionBar placement="inline" count={0} label="0 selected" hint="Click an element to pick it" emptyReason="Pick an element first"
      clearLabel="Clear" onClear={() => undefined} actions={[
        { id: "attach", label: "Add to chat", icon: <MessageSquarePlus size="sm" />, onSelect: () => undefined },
        { id: "scrap", label: "Scrap", icon: <Scrap size="sm" />, onSelect: () => undefined },
      ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The picked-elements toolbar over the page: a count, what to do with the picks, and Clear, on one line at every width.",
  whenToUse: [
    "Pick mode is on, from before the first pick (count 0: hint, unavailable actions)",
    "One or more page elements are picked (PageCard overlay)",
    "The selection stays on the tab after picking ends (compact pill)",
  ],
  whenNotToUse: [
    { when: "Actions on one row of a list", use: "OverflowActionMenu" },
    { when: "Page-wide state such as pick mode itself", use: "PageBand" },
  ],
  recipes: [
    { name: "Two picks", description: "Floating at the page card's bottom centre by default; `inline` in flow. It never overflows its room: icon actions below 620px.", render: () => <TwoPicks /> },
    { name: "Pick mode just started", description: "Count 0: a pick glyph and the hint replace the count; the actions stay in place, unavailable, with `emptyReason` as their tooltip; Clear is hidden.", render: () => <PickingStarted /> },
  ],
  doDont: [
    {
      do: { caption: "Pass actions as data: narrow cards turn them into icon buttons with tooltips.", render: () => <TwoPicks /> },
      dont: { caption: "Hand-built buttons wrap to a second line on narrow pages.", render: () => <ButtonContainer size="xs"><Button size="xs" variant="ghost" text="Add to chat" /><Button size="xs" variant="ghost" text="Save image" /></ButtonContainer> },
    },
    {
      do: { caption: "Show the bar as soon as pick mode starts, at 0, so the actions are where the user will find them.", render: () => <PickingStarted /> },
      dont: { caption: "Do not hide actions that cannot run yet or disable them silently: keep them with a reason.", render: () => <ButtonContainer size="xs"><Button size="xs" variant="ghost" text="Add to chat" disabled /></ButtonContainer> },
    },
  ],
  content: [
    "Count label: 2 selected / 2개 선택됨. Verbs: Add to chat / 대화에 첨부, Scrap / 스크랩, Copy text / 텍스트 복사.",
    "At 0: hint Click an element to pick it / 요소를 눌러 선택하세요; reason Pick an element first / 먼저 요소를 선택하세요.",
  ],
  accessibility: [
    "role toolbar named by the count label (the hint at 0); every action keeps its words as a label or tooltip.",
    "Unavailable actions stay focusable (aria-disabled) so their reason is reachable by keyboard and hover.",
    "Clear is always the last control (hidden at 0).",
  ],
  tokens: ["--browser-band-height", "--popover", "--shadow-window", "--accent", "--muted", "--radius-pill"],
};
