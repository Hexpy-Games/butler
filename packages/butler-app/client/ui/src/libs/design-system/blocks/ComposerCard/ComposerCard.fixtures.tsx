import { Paperclip } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { Notice } from "../Notice";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardCompactPreview,
  ComposerCardExpandedBody,
  ComposerCardToolbar,
  ComposerSendButton,
} from "./ComposerCard";
import { ComposerPlanDecisionForm } from "./ComposerPlanDecisionForm";
import { ComposerPlanToggle } from "./ComposerPlanToggle";

export function ComposerCardFixture() {
  return (
    <>
      <ComposerCard
        dropActive
        expanded={false}
        large
        notice={
          <Notice message="Optional capability guidance" tone="warning" />
        }
        drawer={<div>Attachment and response mode actions</div>}
        onSubmit={(event) => event.preventDefault()}
      >
        <ComposerCardExpandedBody>
          <ComposerCardTextarea
            defaultValue="Draft message with enough text to show the Butler glass composer."
            rows={1}
          />
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label="Attach file">
            <Paperclip size={16} />
          </IconButton>
          <ComposerCardCompactPreview>
            Draft message preview
          </ComposerCardCompactPreview>
          <ComposerPlanToggle
            checked
            label="Plan"
            onCheckedChange={() => undefined}
          />
          <ComposerSendButton aria-label="Send" />
        </ComposerCardToolbar>
      </ComposerCard>
      <ComposerPlanDecisionForm
        acceptLabel="Accept"
        ariaLabel="Plan decision"
        instruction=""
        instructionLabel="Plan instruction"
        instructionPlaceholder="Request a change"
        rejectLabel="Reject"
        submitLabel="Send"
        onAccept={() => undefined}
        onInstructionChange={() => undefined}
        onReject={() => undefined}
        onSubmitInstruction={() => undefined}
      />
    </>
  );
}
