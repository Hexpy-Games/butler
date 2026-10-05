import type { ShowcaseGuidance } from "../../showcase";
import { PillButton } from "../../components/PillButton";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ScrollArea } from "../ScrollArea";
import { Plus } from "../../components/Icons";
import { Textarea } from "../../components/Textarea";
import {
  ComposerCard, ComposerCardTextarea, ComposerCardInlineAction, ComposerSendButton,
} from "./index";

// #region recipe: Follow-up composer
function FollowUpComposer() {
  return (
    <ComposerCard onSubmit={(event) => event.preventDefault()} controls={
      <ScrollArea orientation="x" flush>
        <ButtonContainer size="sm" wrap={false} grow role="group" aria-label="Composer controls">
          <PillButton surface="glass" size="icon-lg" aria-label="More options"><Plus size="md" /></PillButton>
        </ButtonContainer>
      </ScrollArea>
    }>
      <ComposerCardInlineAction action={<ComposerSendButton aria-label="Send" />}>
        <ComposerCardTextarea aria-label="Message" placeholder="Ask for follow-up changes" rows={1} />
      </ComposerCardInlineAction>
    </ComposerCard>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The glass message composer: editor, external controls, inline send/stop button, notices and attached adjunct panels.",
  whenToUse: ["Writing a message to Butler (new chat or follow-up)"],
  whenNotToUse: [
    { when: "A multi-line form field", use: "Textarea" },
    { when: "A search box", use: "Input" },
  ],
  recipes: [{ name: "Follow-up composer", description: "Editor and send on one line; glass controls stay below the card.", render: () => <FollowUpComposer /> }],
  doDont: [
    {
      do: { caption: "The composer keeps glass, radius and send motion consistent.", render: () => <FollowUpComposer /> },
      dont: { caption: "A Textarea with a Send button loses the composer contract.", render: () => <Textarea aria-label="Message" rows={2} /> },
    },
  ],
  content: [
    "Placeholder invites a request (Ask Butler anything / Ask for follow-up changes).",
    "ComposerSendButton disabledReason blocks send and names why in a few words (Model doesn't accept images).",
    "An unknown capability is treated as unavailable (the gateway refuses it), with its own few-word reason (Image support unknown for this model).",
    "Capability feedback is terse and non-intrusive: the disabled state plus a few-word tooltip (disabledReason), at most a brief transient toast for a refused drop or paste; no banners, inline paragraphs, persistent notices, or why/how explanations.",
  ],
  accessibility: [
    "The send button has an aria-label that matches its mode (Send, Stop, Reconnecting).",
    "A disabledReason send button is aria-disabled and a plain button, so its tooltip opens and it cannot submit.",
  ],
  tokens: ["--composer-controls-inset", "--composer-glass-bg", "--composer-glass-filter", "--radius-composer", "--send-bg", "--send-fg"],
};
