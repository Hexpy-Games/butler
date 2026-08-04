import { Paperclip } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { Notice } from "../Notice";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardCompactPreview,
  ComposerCardExpandedBody,
  ComposerCardToolbar,
  ComposerPlanToggle,
  ComposerSendButton,
} from "./ComposerCard";

export function ComposerCardFixture() {
  return (
    <ComposerCard
      expanded={false}
      large
      notice={<Notice message="Optional capability guidance" tone="warning" />}
      onSubmit={(event) => event.preventDefault()}
    >
      <ComposerCardExpandedBody>
        <ComposerCardTextarea defaultValue="Draft message with enough text to show the Butler glass composer." rows={1} />
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label="Attach file"><Paperclip size={16} /></IconButton>
        <ComposerCardCompactPreview>Draft message preview</ComposerCardCompactPreview>
        <ComposerPlanToggle checked label="Plan" onCheckedChange={() => undefined} />
        <ComposerSendButton aria-label="Send" />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
