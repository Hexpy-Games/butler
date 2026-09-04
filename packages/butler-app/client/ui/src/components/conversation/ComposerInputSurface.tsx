import type { RefObject } from "react";
import { ComposerCardExpandedBody } from "@/butler-ds";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFileInput } from "./ComposerFileInput";
import { ComposerTextArea } from "./ComposerTextArea";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import { ComposerPlanDecisionSurface } from "./ComposerPlanDecisionSurface";

export function ComposerInputSurface({
  fileInputRef,
  onFiles,
  planDecision,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  planDecision?: ComposerPlanDecision;
}) {
  if (planDecision && !planDecision.editingInstruction) {
    return <ComposerPlanDecisionSurface decision={planDecision} />;
  }
  return (
    <>
      <ComposerCardExpandedBody>
        <ComposerTextArea placeholder={planDecision?.instructionPlaceholder} />
        <ComposerAttachments />
      </ComposerCardExpandedBody>
      <ComposerToolbar />
      <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
    </>
  );
}
