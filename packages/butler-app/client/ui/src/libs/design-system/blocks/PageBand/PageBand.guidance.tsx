import type { ShowcaseGuidance } from "../../showcase";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ShieldQuestion, Square } from "../../components/Icons";
import { PageBand } from "./PageBand";

// #region recipe: Butler is browsing
function AgentBand() {
  return (
    <PageBand tone="agent" icon={<ButlerThinkingMark size="sm" state="working" />} label="Butler is browsing" detail="Click ‘Mesh Office Chair M2’"
      actions={(
        <ButtonContainer size="xs">
          <Button size="xs" variant="outline" text="Take over" />
          <Button size="xs" variant="outline" iconStart={<Square size="sm" />} text="Stop task" />
        </ButtonContainer>
      )} />
  );
}
// #endregion

// #region recipe: Waiting for approval
function WaitingBand() {
  return (
    <PageBand tone="waiting" icon={<ShieldQuestion size="md" />} label="Waiting for approval" detail="Pay ₩129,000"
      actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text="Review" /></ButtonContainer>} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One 40px line on a PageCard's top edge for page-scoped state: who holds the tab, an approval, your input, picking, a pop-up.",
  whenToUse: ["State that belongs to one page, with up to three actions on it", "Butler's control verbs: Take over, Give back to Butler, Stop task"],
  whenNotToUse: [
    { when: "State of the whole app or a form", use: "Notice" },
    { when: "A transient confirmation (scrapped, moved)", use: "Toast" },
  ],
  recipes: [
    { name: "Butler is browsing", description: "Agent tone: the riso inks, the working mark, two outline buttons.", render: () => <AgentBand /> },
    { name: "Waiting for approval", description: "Decisions happen on the approval card in the chat; the band points there.", render: () => <WaitingBand /> },
  ],
  doDont: [
    {
      do: { caption: "A few words of label, the step as detail; only the detail truncates.", render: () => <AgentBand /> },
      dont: { caption: "A sentence-long label with four buttons wraps and hides the page.", render: () => <PageBand tone="info" label="A pop-up from id.example.com was blocked because it opened without a click" /> },
    },
  ],
  content: [
    "Labels: Butler is browsing / 버틀러가 조작 중, You're in control / 직접 조작 중, Waiting for approval / 승인 대기.",
    "Stop task (작업 중지) ends the task; Take over (직접 조작) pauses Butler on this tab only.",
  ],
  accessibility: ["The label and detail are a polite live region; the actions sit outside it.", "Icons are decorative; the label carries the meaning."],
  tokens: ["--browser-band-height", "--butler-ink-blue", "--butler-ink-purple", "--color-warning-bg", "--color-info-bg"],
};
