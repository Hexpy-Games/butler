import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { createCanonEpic, type CanonPlan, type EpicDetail, type EpicTag } from "@/app/canonApi.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Dialog, DialogContent, DialogForm, Field, FieldLabel, Grid } from "@/butler-ds";
import { CanonTagsField } from "./CanonTagsField.tsx";
import { CanonFormFields } from "./CanonFormFields.tsx";
import { CanonFormFooter } from "./CanonFormFooter.tsx";
import { CanonPlanSelect } from "./CanonPlanSelect.tsx";
import { CanonPersonSelect } from "./CanonPersonSelect.tsx";
import { LOCAL_PERSON_ID } from "./localPerson.ts";
import { canonWriteFailure } from "./canonFeedback.ts";

/** Callers mount on open (and choose navigation after creation). */
export function EpicCreateDialog({ projectId, plans, defaultPlanId = null, onClose, onCreated, onRefresh }: {
  projectId: string; plans: CanonPlan[]; defaultPlanId?: string | null;
  onClose: () => void; onCreated: (epic: EpicDetail) => void; onRefresh: () => Promise<void>;
}) {
  useAppLocale();
  const [tags, setTags] = useState<EpicTag[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState(defaultPlanId);
  const [assignee, setAssignee] = useState<string | null>(LOCAL_PERSON_ID);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const epic = await createCanonEpic(projectId, { title: title.trim(), description, plan_id: plan, assignee, tags: tags.map(tag => tag.id) });
      notifyStatus(appCopy.canon.created); onCreated(epic); onClose();
    } catch (error) { await canonWriteFailure(error, onRefresh); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent size="md" closeLabel={appCopy.canon.close} aria-describedby={undefined}>
      <DialogForm dialog title={appCopy.canon.newEpic} busy={busy} onSubmit={() => void submit()}
        footer={<CanonFormFooter title={title} busy={busy} submitLabel={appCopy.canon.create} onCancel={onClose} />}>
        <CanonFormFields prefix="canon-create" title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
        <CanonTagsField projectId={projectId} value={tags} onChange={setTags} disabled={busy} />
        <Grid columns="2" gap="md">
          <Field><FieldLabel htmlFor="canon-create-plan">{appCopy.canon.plan}</FieldLabel>
            <CanonPlanSelect stretch id="canon-create-plan" plans={plans} value={plan} onChange={setPlan} disabled={busy} /></Field>
          <Field><FieldLabel htmlFor="canon-create-assignee">{appCopy.canon.assignee} · {appCopy.canon.optional}</FieldLabel>
            <CanonPersonSelect stretch id="canon-create-assignee" value={assignee} onChange={setAssignee} disabled={busy} /></Field>
        </Grid>
      </DialogForm>
    </DialogContent>
  </Dialog>;
}
