import { Typo } from "../../components/Typo";
import type { ShowcaseGuidance } from "../../showcase";
import { ComposerQuestionPanel } from "./ComposerQuestionPanel";
import { questionFixtures } from "../ComposerQuestionPanel/fixtures";
import { ComposerCard } from "../ComposerCard";
// #region recipe: Question in the composer
function Example() { return <ComposerCard><ComposerQuestionPanel questions={questionFixtures(false).single} onSubmit={() => undefined} onSkip={() => undefined} onCollapse={() => undefined} /></ComposerCard>; }
// #endregion
export const guidance: ShowcaseGuidance = {
  purpose: "A bounded question form replacing the composer editor and toolbar, with local choices and a review step.",
  whenToUse: ["One to four single, multi or text questions awaiting a user answer"],
  whenNotToUse: [{ when: "A permission decision", use: "ComposerDecisionPanel" }],
  recipes: [{ name: "Question in the composer", description: "Compose existing DS surfaces; caller owns delivery and localized copy.", render: () => <Example /> }],
  doDont: [{ do: { caption: "Keep all answers readable.", render: () => <Example /> }, dont: { caption: "Do not replace skipped questions with a vague success message.", render: () => <Typo.Label>All done</Typo.Label> } }],
  content: ["Use terse localized labels; mark unanswered questions as skipped.", "Recommended is a hint, never a default answer."],
  accessibility: ["Radio and checkbox semantics, labeled inputs, roving row focus and keyboard shortcuts. Native Tabs owns tab keyboard behavior. No motion is added beyond DS primitives."],
  tokens: ["--control-hit-target", "--space-sm", "--icon-size-lg", "--selection"],
};
