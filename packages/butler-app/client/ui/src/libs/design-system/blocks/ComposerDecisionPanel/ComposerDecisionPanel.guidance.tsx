import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Folder, ListChecks } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { ComposerDecisionPanel } from "./ComposerDecisionPanel";

// #region recipe: Plan waiting for acceptance
function PlanDecision() {
  return (
    <ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} title="Design system final cleanup plan" onOpen={() => undefined}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Keep planning</Button>
        <Button size="sm">Accept plan</Button>
      </ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Approval request with examples and risk
function ApprovalRequest() {
  return (
    <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} title="Edit 24 files in your Desktop folder?" onOpen={() => undefined}
      details={["Screenshot 10.02.14.png", "Screenshot 10.05.31.png", "Screenshot 10.09.02.png", "+21 more"]}
      aside={<Tag tone="warning">Medium risk</Tag>}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">Deny</Button>
        <Button size="sm">Allow once</Button>
      </ButtonContainer>} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The composer's decision state: what is being decided, optional detail lines, an optional failure, and the decision buttons in the composer radius.",
  whenToUse: ["A plan waiting for acceptance or an authority request that replaces the composer input"],
  whenNotToUse: [
    { when: "A notice inside the conversation", use: "Notice" },
    { when: "A modal confirmation", use: "Dialog" },
  ],
  recipes: [
    { name: "Plan waiting for acceptance", description: "Icon, clickable title, then a ButtonContainer justify=\"end\" of decisions.", render: () => <PlanDecision /> },
    { name: "Approval request with examples and risk", description: "A one-sentence question, up to three examples and a \"+N more\" line as details, a risk Tag in the aside.", render: () => <ApprovalRequest /> },
  ],
  doDont: [
    {
      do: { caption: "The panel owns the icon tone, title clamp and button radius.", render: () => <PlanDecision /> },
      dont: { caption: "A hand-built row drifts from the composer padding and radius.", render: () => <Stack align="row" gap="sm" cross="center"><ListChecks size="lg" /><Typo.Label>Design system final cleanup plan</Typo.Label><Button size="sm">Accept plan</Button></Stack> },
    },
    {
      do: { caption: "Examples go in details: one truncated line each, aligned to the title.", render: () => <ApprovalRequest /> },
      dont: { caption: "Packing examples into the title clamps them away.", render: () => <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} title="Edit 24 files in your Desktop folder? Screenshot 10.02.14.png, Screenshot 10.05.31.png, Screenshot 10.09.02.png and 21 more" onOpen={() => undefined} actions={<Button size="sm">Allow once</Button>} /> },
    },
  ],
  content: [
    "The title names the plan, or asks what the request will do: what, where and how many (Edit 24 files in your Desktop folder?).",
    "Details are short concrete items (file names, the command line), at most three, then \"+N more\".",
    "Buttons are verbs (Accept plan, Deny, Allow once).",
  ],
  accessibility: ["The icon is decorative (aria-hidden); the title is a button that opens the source; details are plain text; errors are announced with role=\"alert\"."],
  tokens: ["--adaptive-composer-radius", "--space-xs", "--space-sm", "--space-md", "--space-lg", "--icon-size-lg", "--text-secondary"],
};
