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
import { TodoProgressPanel } from "./TodoProgressPanel";

export function TodoProgressPanelFixture() {
  return (
    <ComposerCard
      large
      adjunct={
        <TodoProgressPanel
          heading="Progress steps"
          items={[
            {
              id: "orient",
              title: "Understand the request",
              state: "completed",
              statusLabel: "Done",
            },
            {
              id: "inspect",
              title: "Inspect relevant files",
              state: "running",
              statusLabel: "Running",
            },
            {
              id: "report",
              title: "Prepare final answer",
              state: "pending",
              statusLabel: "Pending",
            },
          ]}
        />
      }
      onSubmit={(event) => event.preventDefault()}
    >
      <ComposerCardTextarea
        defaultValue="Draft message while the progress panel stays attached to the composer."
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
