import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Space } from "./Space";

// #region recipe: Gap before attachments
function AnswerThenAttachments() {
  return (
    <div>
      <Typo.Body>I updated the settings pages.</Typo.Body>
      <Space size="md" />
      <Typo.Caption>release-notes.md · design-review.png</Typo.Caption>
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An empty token-sized spacer where siblings do not live in a Stack.",
  whenToUse: ["Add one gap between siblings that are not in a Stack (message body and its attachments)"],
  whenNotToUse: [
    { when: "Regular spacing between siblings", use: "Stack" },
    { when: "A visible divider", use: "Separator" },
  ],
  recipes: [{ name: "Gap before attachments", description: "Space size=\"md\" separates an answer from its files.", render: () => <AnswerThenAttachments /> }],
  doDont: [
    {
      do: { caption: "A Stack gap when the siblings are yours to lay out.", render: () => <Stack gap="md"><Typo.Body>Answer</Typo.Body><Typo.Caption>Files</Typo.Caption></Stack> },
      dont: { caption: "A Space between every child re-implements Stack.", render: () => <div><Typo.Body>Answer</Typo.Body><Space size="md" /><Typo.Caption>Files</Typo.Caption><Space size="md" /><Typo.Caption>More</Typo.Caption></div> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["aria-hidden; never focusable."],
  tokens: ["--space-md", "--space-lg"],
};
