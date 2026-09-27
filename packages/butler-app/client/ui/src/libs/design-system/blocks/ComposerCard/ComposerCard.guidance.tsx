import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Plus } from "../../components/Icons";
import { Textarea } from "../../components/Textarea";
import {
  ComposerCard, ComposerCardExpandedBody, ComposerCardTextarea, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton,
} from "./index";

// #region recipe: Follow-up composer
function FollowUpComposer() {
  return (
    <ComposerCard onSubmit={(event) => event.preventDefault()}>
      <ComposerCardExpandedBody>
        <ComposerCardTextarea aria-label="Message" placeholder="Ask for follow-up changes" rows={1} />
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label="More options"><Plus size="md" /></IconButton>
        <ComposerCardToolbarSpacer />
        <ComposerSendButton aria-label="Send" />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The glass message composer: editor, toolbar, send/stop button, notices and attached adjunct panels.",
  whenToUse: ["Writing a message to Butler (new chat or follow-up)"],
  whenNotToUse: [
    { when: "A multi-line form field", use: "Textarea" },
    { when: "A search box", use: "Input" },
  ],
  recipes: [{ name: "Follow-up composer", description: "Body, toolbar with a spacer, and the send button last.", render: () => <FollowUpComposer /> }],
  doDont: [
    {
      do: { caption: "The composer keeps glass, radius and send motion consistent.", render: () => <FollowUpComposer /> },
      dont: { caption: "A Textarea with a Send button loses the composer contract.", render: () => <Textarea aria-label="Message" rows={2} /> },
    },
  ],
  content: [
    "Placeholder invites a request (Ask Butler anything / Ask for follow-up changes).",
    "ComposerSendButton disabledReason blocks send and names why in a few words (Model doesn't accept images).",
    "Capability feedback is terse and non-intrusive: the disabled state plus a few-word tooltip (disabledReason), at most a brief transient toast for a refused drop or paste; no banners, inline paragraphs, persistent notices, or why/how explanations.",
  ],
  accessibility: [
    "The send button has an aria-label that matches its mode (Send, Stop, Reconnecting).",
    "A disabledReason send button is aria-disabled and a plain button, so its tooltip opens and it cannot submit.",
  ],
  tokens: ["--composer-glass-bg", "--composer-glass-filter", "--radius-composer", "--send-bg", "--send-fg"],
};
