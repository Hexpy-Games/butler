import { Typo } from "../../components/Typo";
import type { ShowcaseGuidance } from "../../showcase";
import { ComposerQuestionPanel } from "./ComposerQuestionPanel";
import { questionFixtures } from "../ComposerQuestionPanel/fixtures";
import { ComposerCard } from "../ComposerCard";
// #region recipe: Question in the composer
function Example() { return <ComposerCard><ComposerQuestionPanel questions={questionFixtures(false).single} onSubmit={() => undefined} onSkip={() => undefined} onCollapse={() => undefined} /></ComposerCard>; }
// #endregion
// #region recipe: Question in the conversation
function ConversationExample() { return <ComposerQuestionPanel placement="conversation" questions={questionFixtures(false).single} onSubmit={() => undefined} onSkip={() => undefined} onCollapse={() => undefined} />; }
// #endregion
export const guidance: ShowcaseGuidance = {
  purpose: "A bounded question form replacing the composer editor and toolbar, or shown in the conversation where Butler asked, with local choices and a review step.",
  whenToUse: ["One to four single, multi or text questions awaiting a user answer", "The same question in the transcript (placement=\"conversation\")"],
  whenNotToUse: [{ when: "A permission decision", use: "ComposerDecisionPanel" }],
  recipes: [
    { name: "Question in the composer", description: "Compose existing DS surfaces; caller owns delivery and localized copy.", render: () => <Example /> },
    { name: "Question in the conversation", description: "placement=\"conversation\": the panel brings its own flat Card radius=\"lg\" and control-radius buttons; no ComposerCard.", render: () => <ConversationExample /> },
  ],
  doDont: [{ do: { caption: "Keep all answers readable.", render: () => <Example /> }, dont: { caption: "Do not replace skipped questions with a vague success message.", render: () => <Typo.Label>All done</Typo.Label> } }],
  content: ["Use terse localized labels; mark unanswered questions as skipped.", "Recommended is a hint, never a default answer."],
  accessibility: ["Radio and checkbox semantics, labeled inputs, roving row focus and keyboard shortcuts. Native Tabs owns tab keyboard behavior. No motion is added beyond DS primitives."],
  tokens: ["--control-hit-target", "--space-sm", "--space-md", "--icon-size-lg", "--selection", "--adaptive-composer-radius", "--radius-control", "--radius-popover"],
};
