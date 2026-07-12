import type { RefObject } from "react";
import { ComposerCardExpandedBody } from "@/butler-ds";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFileInput } from "./ComposerFileInput";
import { ComposerTextArea } from "./ComposerTextArea";
import { ComposerToolbar } from "./ComposerToolbar";

export function ComposerInputSurface({
  fileInputRef,
  onFiles,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <>
      <ComposerCardExpandedBody>
        <ComposerTextArea />
        <ComposerAttachments />
      </ComposerCardExpandedBody>
      <ComposerToolbar />
      <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
    </>
  );
}
