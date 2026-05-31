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
import { WorkerActivityPanel } from "./WorkerActivityPanel";

export function WorkerActivityPanelFixture() {
  return (
    <ComposerCard
      large
      adjunct={
        <WorkerActivityPanel
          heading="Workers"
          collapsedSummary="Worker 1 Executing: Reading project files 외 1개"
          items={[
            {
              id: "worker-1",
              title: "Worker 1",
              description: "Reading project files and extracting implementation notes.",
              meta: "Executing",
              phase: "executing",
            },
            {
              id: "worker-2",
              title: "Worker 2",
              description: "Reviewing the gathered evidence.",
              meta: "Verifying",
              phase: "verifying",
              depth: 1,
            },
          ]}
        />
      }
      onSubmit={(event) => event.preventDefault()}
    >
      <ComposerCardTextarea
        defaultValue="Draft message while worker activity remains attached to the composer."
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
