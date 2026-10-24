import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail, EpicInput } from "@/app/canonApi.ts";
import { DialogForm } from "@/butler-ds";
import { CanonTagsField } from "./CanonTagsField.tsx";
import { CanonFormFields } from "./CanonFormFields.tsx";
import { CanonFormFooter } from "./CanonFormFooter.tsx";
export function EpicEditForm({ epic, busy, onSave, onClose }: {
  epic: EpicDetail; busy: boolean; onSave: (input: EpicInput) => Promise<boolean>; onClose: () => void;
}) {
  // Keep the revision that the person began editing, even during live refetches.
  const [base] = useState(epic);
  const [tags, setTags] = useState(epic.tags);
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description);
  const submit = async () => {
    if (!title.trim() || busy) return;
    await onSave({ title: title.trim(), description, tags: tags.map(tag => tag.id), expected_revision: base.revision });
    onClose();
  };
  return <DialogForm title={appCopy.canon.edit} busy={busy} onSubmit={() => void submit()}
    footer={<CanonFormFooter title={title} busy={busy} submitLabel={appCopy.canon.save} onCancel={onClose} />}>
    <CanonFormFields prefix="canon-edit" title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
    <CanonTagsField projectId={epic.project_id} value={tags} onChange={setTags} disabled={busy} />
  </DialogForm>;
}
