import type {
  AccessMode,
  ComposerControls,
  MessageFileRef,
  ReasoningEffort,
} from "../../../app/types.ts";

interface SubmitAttachment {
  file: MessageFileRef;
}

export function composerControlsForSubmit(input: {
  model: string;
  reasoning: ReasoningEffort;
  accessMode: AccessMode;
  planMode: boolean;
  controlsTouched: boolean;
  activeTurn: boolean;
  attachments: SubmitAttachment[];
}): ComposerControls {
  return {
    ...(input.controlsTouched
      ? {
          model: input.model,
          reasoningEffort: input.reasoning,
          accessMode: input.accessMode,
          planMode: input.planMode,
        }
      : {}),
    queuePolicy: input.activeTurn ? "enqueue_if_busy" : "send_now",
    attachments: input.attachments.map((attachment) => attachment.file),
  };
}
