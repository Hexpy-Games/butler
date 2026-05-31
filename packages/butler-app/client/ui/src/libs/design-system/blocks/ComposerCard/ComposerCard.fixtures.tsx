import { Paperclip } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerPlanToggle,
  ComposerSendButton,
} from "./ComposerCard";

export function ComposerCardFixture() {
  return (
    <ComposerCard large onSubmit={(event) => event.preventDefault()}>
      <ComposerCardTextarea defaultValue="Draft message with enough text to show the Butler glass composer." rows={3} />
      <ComposerCardToolbar>
        <IconButton label="Attach file"><Paperclip size={16} /></IconButton>
        <ComposerPlanToggle checked label="Plan" onCheckedChange={() => undefined} />
        <ComposerSendButton aria-label="Send" />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
