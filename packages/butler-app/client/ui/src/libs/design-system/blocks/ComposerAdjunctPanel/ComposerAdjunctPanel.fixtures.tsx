import { ListChecks, Paperclip } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerPlanToggle,
  ComposerSendButton,
} from "../ComposerCard";
import { ComposerAdjunctPanel } from "./ComposerAdjunctPanel";

export function ComposerAdjunctPanelFixture() {
  return (
    <ComposerCard
      large
      adjunct={
        <ComposerAdjunctPanel
          heading="Attached panel"
          icon={<ListChecks size={15} />}
        >
          <span>Panel content follows the same composer inset rhythm.</span>
        </ComposerAdjunctPanel>
      }
      onSubmit={(event) => event.preventDefault()}
    >
      <ComposerCardTextarea
        defaultValue="Draft message with an attached adjunct panel."
        rows={3}
      />
      <ComposerCardToolbar>
        <IconButton label="Attach file">
          <Paperclip size={16} />
        </IconButton>
        <ComposerPlanToggle
          checked
          label="Plan"
          onCheckedChange={() => undefined}
        />
        <ComposerCardToolbarSpacer />
        <ComposerSendButton aria-label="Send" />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
