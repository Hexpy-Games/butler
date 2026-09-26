import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ListChecks } from "../../components/Icons";
import { Stack } from "../../components/Stack";
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

export const guidance: ShowcaseGuidance = {
  purpose: "The composer's decision state: what is being decided, an optional failure, and the decision buttons in the composer radius.",
  whenToUse: ["A plan waiting for acceptance or an authority request that replaces the composer input"],
  whenNotToUse: [
    { when: "A notice inside the conversation", use: "Notice" },
    { when: "A modal confirmation", use: "Dialog" },
  ],
  recipes: [{ name: "Plan waiting for acceptance", description: "Icon, clickable title, then a ButtonContainer justify=\"end\" of decisions.", render: () => <PlanDecision /> }],
  doDont: [
    {
      do: { caption: "The panel owns the icon tone, title clamp and button radius.", render: () => <PlanDecision /> },
      dont: { caption: "A hand-built row drifts from the composer padding and radius.", render: () => <Stack align="row" gap="sm" cross="center"><ListChecks size="lg" /><Typo.Label>Design system final cleanup plan</Typo.Label><Button size="sm">Accept plan</Button></Stack> },
    },
  ],
  content: ["The title names the plan or the requested permission; buttons are verbs (Accept plan, Deny, Allow once)."],
  accessibility: ["The icon is decorative (aria-hidden); the title is a button that opens the source; errors are announced with role=\"alert\"."],
  tokens: ["--adaptive-composer-radius", "--space-md", "--space-lg", "--text-secondary"],
};
