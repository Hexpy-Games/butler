import { useId, useLayoutEffect, useRef, useState, type DragEvent, type SyntheticEvent } from "react";
import { Button, ButtonContainer, Input, Tooltip } from "@/butler-ds";
import { useCanonInlineUploads } from "./CanonInlineDraft.tsx";
import { appCopy } from "@/app/copy.ts";
import { uploadCanonFile } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";

/** The same small upload control is composed into both existing epic forms. */
export function useEpicAttachments(projectId: string, description: string, onDescription: (value: string) => void, disabled: boolean) {
  const pickerId = useId();
  const selection = useRef<{ element: HTMLTextAreaElement; start: number; end: number } | null>(null);
  const [{ pendingFile, files }, setUpload] = useCanonInlineUploads();
  const uploading = Boolean(pendingFile);
  const caret = useRef<{ element: HTMLTextAreaElement; position: number } | null>(null);
  useLayoutEffect(() => {
    const next = caret.current;
    if (!next) return;
    caret.current = null;
    next.element.focus();
    next.element.setSelectionRange(next.position, next.position);
  }, [description]);
  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    selection.current = { element, start: element.selectionStart, end: element.selectionEnd };
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { notifyError(null, appCopy.canon.fileTooLarge); return; }
    setUpload(current => ({ ...current, pendingFile: file }));
    try {
      const attached = await uploadCanonFile(projectId, file);
      setUpload(current => ({ ...current, files: [...current.files, attached] }));
      const name = attached.safe_name.replace(/[\\\[\]]/gu, "\\$&").replace(/[\r\n]/gu, " ");
      const reference = `${attached.kind === "image" ? "!" : ""}[${name}](attachment:${attached.file_id})`;
      const saved = selection.current;
      const text = saved?.element.value ?? description;
      const start = saved?.start ?? text.length, end = saved?.end ?? text.length;
      onDescription(text.slice(0, start) + reference + text.slice(end));
      if (saved) {
        caret.current = { element: saved.element, position: start + reference.length };
        selection.current = { ...saved, start: start + reference.length, end: start + reference.length };
      }
    } catch (error) {
      const code = apiErrorCode(error);
      const copy = code === "file_too_large" ? appCopy.canon.fileTooLarge
        : code === "too_many_attachments" ? appCopy.canon.tooManyAttachments : undefined;
      notifyError(copy ? null : error, copy ?? appCopy.interfaceFeedback.uploadFailed);
    }
    finally { setUpload(current => ({ ...current, pendingFile: null })); }
  };
  const [dropActive, setDropActive] = useState(false);
  const fileDrag = (event: DragEvent<HTMLTextAreaElement>) => !disabled && !uploading && event.dataTransfer.types.includes("Files");
  // Props for the description Textarea: a dropped file takes the button's upload path, at the editor's caret.
  const drop = {
    dropActive, "data-file-drop": true,
    onDragEnter: (event: DragEvent<HTMLTextAreaElement>) => { if (fileDrag(event)) { event.preventDefault(); setDropActive(true); } },
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: () => setDropActive(false),
    onDrop: (event: DragEvent<HTMLTextAreaElement>) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      setDropActive(false);
      onSelect(event);
      const dropped = Array.from(event.dataTransfer.files);
      void (async () => { for (const file of dropped) await upload(file); })();
    },
  };
  const control = <ButtonContainer size="sm">
    <Input type="file" hidden aria-label={appCopy.canon.attachFile} id={pickerId} disabled={disabled || uploading}
      onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    <Tooltip wrap label={uploading ? appCopy.canon.uploadingFile : disabled ? appCopy.canon.saving : undefined}>
      <Button type="button" size="sm" variant="outline" disabled={disabled || uploading}
        onClick={() => { const picker = document.getElementById(pickerId); if (picker instanceof HTMLInputElement) picker.click(); }}>{appCopy.canon.attachFile}</Button>
    </Tooltip>
  </ButtonContainer>;
  return { control, onSelect, drop, uploading, pendingFile, files };
}
