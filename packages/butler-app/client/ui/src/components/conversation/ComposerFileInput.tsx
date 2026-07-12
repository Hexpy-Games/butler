import type { RefObject } from "react";

export function ComposerFileInput({
  inputRef,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <input
      ref={inputRef}
      data-picker-filter="all-files"
      hidden
      multiple
      type="file"
      onChange={(event) => {
        onFiles(event.currentTarget.files);
        event.currentTarget.value = "";
      }}
    />
  );
}
