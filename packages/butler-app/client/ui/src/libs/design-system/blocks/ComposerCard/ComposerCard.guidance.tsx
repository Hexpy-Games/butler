import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Plus } from "../../components/Icons";
import { Textarea } from "../../components/Textarea";
import {
  ComposerCard, ComposerCardExpandedBody, ComposerCardTextarea, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerDecoration,
  ComposerSendButton, composerDecorationEdge,
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

// #region recipe: Decorated new-chat composer
// Product code picks a scene by name; the tuning (waterline, exposure, gradient, no day clouds) lives in the DS.
const SHORELINE_EDGE = composerDecorationEdge("shoreline");

function DecoratedComposer() {
  return (
    <ComposerCard large decoration={<ComposerDecoration scene="shoreline" />} edge={SHORELINE_EDGE}
      onSubmit={(event) => event.preventDefault()}>
      <ComposerCardExpandedBody>
        <ComposerCardTextarea aria-label="Message" placeholder="Ask Butler anything" rows={1} />
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
  recipes: [
    { name: "Follow-up composer", description: "Body, toolbar with a spacer, and the send button last.", render: () => <FollowUpComposer /> },
    {
      name: "Decorated new-chat composer",
      description: "decoration takes a ComposerDecoration scene (art under the content, no scrim); edge takes its character, anchored to the card's top edge; its reserveTop pads the wrap so the measured height includes it.",
      render: () => <DecoratedComposer />,
    },
  ],
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
    "decoration and edge are aria-hidden and take no pointer events; readability comes from the scene's own grade, never a layer behind the text.",
    "The send button has an aria-label that matches its mode (Send, Stop, Reconnecting).",
    "A disabledReason send button is aria-disabled and a plain button, so its tooltip opens and it cannot submit.",
  ],
  tokens: ["--composer-glass-bg", "--composer-glass-filter", "--radius-composer", "--send-bg", "--send-fg"],
};
