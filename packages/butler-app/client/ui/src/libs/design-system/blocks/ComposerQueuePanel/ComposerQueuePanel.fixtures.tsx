import { Paperclip } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerPlanToggle,
  ComposerSendButton,
} from "../ComposerCard";
import { ComposerQueuePanel } from "./ComposerQueuePanel";

export function ComposerQueuePanelFixture() {
  return (
    <ComposerCard
      large
      adjunct={
        <ComposerQueuePanel
          heading="Queued messages"
          editLabel="Edit queued message"
          deleteLabel="Delete queued message"
          onEdit={() => undefined}
          onDelete={() => undefined}
          items={[
            {
              id: "queued-1",
              label: "Add screenshots to the final report before sending.",
              badge: "Queued",
              ariaLabel: "Add screenshots to the final report before sending.",
            },
            {
              id: "queued-2",
              label: "Also mention that MCP secrets stay redacted.",
              badge: "1 file",
              ariaLabel: "Also mention that MCP secrets stay redacted.",
            },
          ]}
        />
      }
      onSubmit={(event) => event.preventDefault()}
    >
      <ComposerCardTextarea
        defaultValue="Draft message while Butler is still working."
        rows={3}
      />
      <ComposerCardToolbar>
        <IconButton label="Attach file">
          <Paperclip size={16} />
        </IconButton>
        <ComposerPlanToggle checked label="Plan" onCheckedChange={() => undefined} />
        <ComposerCardToolbarSpacer />
        <ComposerSendButton aria-label="Send" />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
