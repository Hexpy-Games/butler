import { useEffect, useRef, useState } from "react";

export function useComposerFileDrop(
  onFiles: (files: FileList) => void,
) {
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const dragDepth = useRef(0);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    const resetDragState = () => {
      dragDepth.current = 0;
      setIsFileDragActive(false);
    };

    const onDragEnter = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!hasFilePayload(dataTransfer)) return;
      event.preventDefault();
      dataTransfer.dropEffect = "copy";
      dragDepth.current += 1;
      setIsFileDragActive(true);
    };

    const onDragOver = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!hasFilePayload(dataTransfer)) return;
      event.preventDefault();
      dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!hasFilePayload(dataTransfer)) return;
      event.preventDefault();
      if (event.relatedTarget == null) {
        resetDragState();
        return;
      }
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsFileDragActive(false);
    };

    const onDrop = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!hasFilePayload(dataTransfer)) return;
      event.preventDefault();
      resetDragState();
      const files = dataTransfer.files;
      if (!files || files.length === 0) return;
      onFilesRef.current(files);
    };

    const onDragEnd = () => resetDragState();
    const capture = true;
    window.addEventListener("dragenter", onDragEnter, capture);
    window.addEventListener("dragover", onDragOver, capture);
    window.addEventListener("dragleave", onDragLeave, capture);
    window.addEventListener("drop", onDrop, capture);
    window.addEventListener("dragend", onDragEnd, capture);

    return () => {
      window.removeEventListener("dragenter", onDragEnter, capture);
      window.removeEventListener("dragover", onDragOver, capture);
      window.removeEventListener("dragleave", onDragLeave, capture);
      window.removeEventListener("drop", onDrop, capture);
      window.removeEventListener("dragend", onDragEnd, capture);
      dragDepth.current = 0;
    };
  }, []);

  return { dropActive: isFileDragActive };
}

function hasFilePayload(
  dataTransfer: DataTransfer | null,
): dataTransfer is DataTransfer {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []).map((type) =>
    type.toLowerCase(),
  );
  return types.includes("files") || (dataTransfer.files?.length ?? 0) > 0;
}
