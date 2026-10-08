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

export const guidance: ShowcaseGuidance = {
  purpose: "The picked-elements toolbar over the page: a count, what to do with the picks, and Clear, on one line at every width.",
  whenToUse: ["One or more page elements are picked (PageCard overlay)", "The selection stays on the tab after picking ends (compact pill)"],
  whenNotToUse: [
    { when: "Actions on one row of a list", use: "OverflowActionMenu" },
    { when: "Page-wide state such as pick mode itself", use: "PageBand" },
  ],
  recipes: [{ name: "Two picks", description: "Floating at the page card's bottom centre by default; `inline` in flow.", render: () => <TwoPicks /> }],
  doDont: [
    {
      do: { caption: "Pass actions as data: narrow cards turn them into icon buttons with tooltips.", render: () => <TwoPicks /> },
      dont: { caption: "Hand-built buttons wrap to a second line on narrow pages.", render: () => <ButtonContainer size="xs"><Button size="xs" variant="ghost" text="Add to chat" /><Button size="xs" variant="ghost" text="Save image" /></ButtonContainer> },
    },
  ],
  content: ["Count label: 2 selected / 2개 선택됨. Verbs: Add to chat / 대화에 첨부, Scrap / 스크랩, Copy text / 텍스트 복사."],
  accessibility: ["role toolbar named by the count label; every action keeps its words as a label or tooltip.", "Clear is always the last control."],
  tokens: ["--browser-band-height", "--popover", "--shadow-window", "--accent", "--radius-pill"],
};
