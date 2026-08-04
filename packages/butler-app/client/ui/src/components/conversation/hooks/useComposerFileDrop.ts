import { useCallback, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

type ComposerDragEvent = ReactDragEvent<HTMLFormElement>;

export function useComposerFileDrop(
  onFiles: (files: FileList) => void,
) {
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const dragDepth = useRef(0);

  const onDragEnter = useCallback((event: ComposerDragEvent) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsFileDragActive(true);
  }, []);

  const onDragOver = useCallback((event: ComposerDragEvent) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: ComposerDragEvent) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsFileDragActive(false);
  }, []);

  const onDrop = useCallback(
    (event: ComposerDragEvent) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setIsFileDragActive(false);
      onFiles(event.dataTransfer.files);
    },
    [onFiles],
  );

  return {
    dropActive: isFileDragActive,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  };
}

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []).map((type) =>
    type.toLowerCase(),
  );
  return types.includes("files") || dataTransfer.files.length > 0;
}
