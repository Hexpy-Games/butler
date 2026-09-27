import type { RefObject } from "react";
import { attachmentPickerFilter, composerImagePolicy } from "./composerImagePolicy";
import { useComposerStore } from "./composerStore";

export function ComposerFileInput({
  inputRef,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
}) {
  const pickerKind = useComposerStore((store) => store.pickerKind);
  const activeModel = useComposerStore((store) => store.activeModel);
  const picker = attachmentPickerFilter(pickerKind, composerImagePolicy(activeModel));
  const resetPicker = () => useComposerStore.setState({ pickerKind: "files" });
  return (
    <input
      ref={inputRef}
      accept={picker.accept}
      data-picker-filter={picker.filter}
      hidden
      multiple
      type="file"
      onChange={(event) => {
        onFiles(event.currentTarget.files);
        event.currentTarget.value = "";
        resetPicker();
      }}
    />
  );
}
