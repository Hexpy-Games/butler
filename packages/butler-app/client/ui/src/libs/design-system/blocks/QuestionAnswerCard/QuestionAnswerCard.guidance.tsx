import { Typo } from "../../components/Typo";
import type { ShowcaseGuidance } from "../../showcase";
import { QuestionAnswerCard } from "./QuestionAnswerCard";
import { questionFixtures } from "../ComposerQuestionPanel/fixtures";
// #region recipe: Answer in the transcript
function Example() { return <QuestionAnswerCard questions={questionFixtures(false).onboarding} variant="skipped" />; }
// #endregion
export const guidance: ShowcaseGuidance = {
  purpose: "A readable answer summary on the user side of the transcript, including skipped and message answers.",
  whenToUse: ["A completed question response in a conversation"],
  whenNotToUse: [{ when: "A permission decision", use: "ComposerDecisionPanel" }],
  recipes: [{ name: "Answer in the transcript", description: "Compose existing DS surfaces; caller owns delivery and localized copy.", render: () => <Example /> }],
  doDont: [{ do: { caption: "Keep all answers readable.", render: () => <Example /> }, dont: { caption: "Do not replace skipped questions with a vague success message.", render: () => <Typo.Label>All done</Typo.Label> } }],
  content: ["Use terse localized labels; mark unanswered questions as skipped.", "Recommended is a hint, never a default answer."],
  accessibility: ["User MessageRow owns transcript placement; every question keeps its header and complete answer."],
  tokens: ["--control-hit-target", "--space-sm", "--icon-size-lg", "--selection"],
};
