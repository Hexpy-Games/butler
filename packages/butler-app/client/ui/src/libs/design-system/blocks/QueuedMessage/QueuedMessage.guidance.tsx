import type { ShowcaseGuidance } from "../../showcase";
import { MessageRow } from "../MessageRow";
import { QueuedMessage } from "./QueuedMessage";

// #region recipe: Second message in the queue
function QueuedFollowUp() {
  return (
    <QueuedMessage status="Queued · 2 of 3" editLabel="Edit queued message" onEdit={() => undefined}
      deleteLabel="Delete queued message" onDelete={() => undefined}>
      Also mention that MCP secrets stay redacted.
    </QueuedMessage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A pending user bubble for a follow-up sent while a turn runs, with its position, edit and delete.",
  whenToUse: ["Show queued or failed sends at the end of the conversation"],
  whenNotToUse: [
    { when: "A delivered message", use: "MessageRow" },
    { when: "Composer-side status", use: "ComposerAdjunctPanel" },
  ],
  recipes: [{ name: "Second message in the queue", description: "Status carries the position; edit loads it back into the composer.", render: () => <QueuedFollowUp /> }],
  doDont: [
    {
      do: { caption: "A dashed bubble says it has not been sent yet.", render: () => <QueuedFollowUp /> },
      dont: { caption: "A normal user bubble pretends the message was delivered.", render: () => <MessageRow role="user">Also mention that MCP secrets stay redacted.</MessageRow> },
    },
  ],
  content: ["Status: Queued, Queued · 2 of 3, Sending…, Send failed (대기 중 · 3개 중 2번째)."],
  accessibility: ["Edit and delete are labelled IconButtons; long text toggles with Show more / Show less."],
  tokens: ["--user-message-bg", "--border-hairline", "--motion-slow", "--motion-ease-decelerate"],
};
