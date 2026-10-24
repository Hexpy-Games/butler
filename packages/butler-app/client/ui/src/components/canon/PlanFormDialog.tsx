import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { createCanonPlan, editCanonPlan, type CanonPlan } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { Dialog, DialogContent, DialogForm, Field, FieldLabel, Input } from "@/butler-ds";
import { CanonFormFields } from "./CanonFormFields.tsx";
import { CanonFormFooter } from "./CanonFormFooter.tsx";
import { canonWriteFailure } from "./canonFeedback.ts";
export function PlanFormDialog({ projectId, plan, onClose, onRefresh, onCreated }: {
  projectId: string; plan?: CanonPlan; onCreated?: (id: string) => void; onClose: () => void; onRefresh: () => Promise<void>;
}) {
  useAppLocale();
  const [title, setTitle] = useState(plan?.title ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [due, setDue] = useState(plan?.due_on ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const input = { title: title.trim(), description, due_on: due || null };
    let createdId: string | undefined;
    try {
      if (plan) await editCanonPlan(plan.id, { ...input, expected_revision: plan.revision });
      else { const created = await createCanonPlan(projectId, input); createdId = created.id; }
      await onRefresh(); if (createdId) onCreated?.(createdId); onClose();
    } catch (error) {
      await canonWriteFailure(error, onRefresh);
      if (apiErrorCode(error) === "conflict") onClose();
    } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent size="md" closeLabel={appCopy.canon.close} aria-describedby={undefined}>
      <DialogForm dialog title={plan ? appCopy.canon.edit : appCopy.canon.newPlan} busy={busy} onSubmit={() => void submit()}
        footer={<CanonFormFooter title={title} busy={busy} submitLabel={plan ? appCopy.canon.save : appCopy.canon.create} onCancel={onClose} />}>
        <CanonFormFields prefix="canon-plan" title={title} description={description} onTitle={setTitle} onDescription={setDescription} />
        <Field><FieldLabel htmlFor="canon-plan-due">{appCopy.canon.dueOn} · {appCopy.canon.optional}</FieldLabel>
          <Input id="canon-plan-due" type="date" value={due} onChange={event => setDue(event.target.value)} /></Field>
      </DialogForm>
    </DialogContent>
  </Dialog>;
}
