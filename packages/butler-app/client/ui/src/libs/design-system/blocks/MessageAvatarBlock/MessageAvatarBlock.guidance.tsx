import type { ShowcaseGuidance } from "../../showcase";
import { Bot } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MessageAvatarBlock } from "./MessageAvatarBlock";

// #region recipe: System message avatar
function SystemAvatar() {
  return <MessageAvatarBlock role="system"><Bot size="md" /></MessageAvatarBlock>;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The round avatar slot for system messages (and the active assistant mark where a gutter exists).",
  whenToUse: ["A system message that needs a visual marker"],
  whenNotToUse: [
    { when: "Assistant answers (the mark lives in the status line)", use: "MessageStatusLabel" },
    { when: "A status icon in a list", use: "ActivityFeed" },
  ],
  recipes: [{ name: "System message avatar", description: "Pass the glyph as children; role picks the surface.", render: () => <SystemAvatar /> }],
  doDont: [
    {
      do: { caption: "Avatar only for system messages.", render: () => <SystemAvatar /> },
      dont: { caption: "An avatar gutter beside every assistant answer narrows the reading width.", render: () => <Stack align="row" gap="sm"><MessageAvatarBlock active /><Typo.Body>Answer squeezed by a gutter</Typo.Body></Stack> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["Decorative; the message content identifies the speaker."],
  tokens: ["--radius-pill", "--surface-raised", "--icon-size-md"],
};
