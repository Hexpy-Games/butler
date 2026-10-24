import { useEffect, useState } from "react";
import { deleteCanonTag, editCanonTag, getCanon, type CanonTag, type CanonTagColor } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm, Field, FieldLabel, Input, Stack, TagColorSwatches } from "@/butler-ds";
import { canonWriteFailure } from "./canonFeedback.ts";
export type TagAction = "rename" | "color" | "delete";
export function CanonTagManageDialog({ tag, action, onClose, onRefresh, onDeleted }: {
  tag: CanonTag; action: TagAction; onDeleted: () => void; onClose: () => void; onRefresh: () => Promise<void>;
}) {
  useAppLocale();
  const copy = appCopy.canon.tags;
  const [name, setName] = useState(tag.name), [color, setColor] = useState<CanonTagColor>(tag.color);
  const [count, setCount] = useState<number | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (action !== "delete") return;
    let active = true;
    void getCanon(tag.project_id).then(canon => {
      const epics = [...canon.backlog, ...canon.plans.flatMap(plan => plan.works)];
      if (active) setCount(epics.filter(epic => epic.tags.some(item => item.id === tag.id)).length);
    }).catch(error => { if (active) void canonWriteFailure(error, onRefresh); });
    return () => { active = false; };
  }, [tag.id, tag.project_id, action, onRefresh]);
  const submit = async () => {
    if (busy || (action === "delete" ? count === null : !name.trim())) return;
    setBusy(true);
    try {
      if (action === "delete") { await deleteCanonTag(tag.id); onDeleted(); }
      else await editCanonTag(tag.id, { expected_revision: tag.revision, ...(action === "rename" ? { name: name.trim() } : { color }) });
      await onRefresh(); onClose();
    } catch (error) {
      await canonWriteFailure(error, onRefresh);
      if (apiErrorCode(error) === "conflict") onClose();
    } finally { setBusy(false); }
  };
  const deleting = action === "delete";
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent size="sm" closeLabel={appCopy.canon.close} aria-describedby={undefined}>
      <Stack onSubmit={event => event.stopPropagation()}>
      <DialogForm dialog title={deleting ? copy.deleteTitle(tag.name) : action === "rename" ? copy.rename : copy.recolor}
        description={deleting ? count === null ? copy.loading : copy.deleteDetail(count) : undefined}
        busy={busy} onSubmit={() => void submit()} footer={<ButtonContainer size="sm" justify="end">
          <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onClose}>{appCopy.canon.cancel}</Button>
          <Button size="sm" type="submit" variant={deleting ? "destructive" : "default"}
            disabled={busy || (deleting ? count === null : !name.trim())}>{deleting ? copy.remove : appCopy.canon.save}</Button>
        </ButtonContainer>}>
        {action === "rename" && <Field><FieldLabel htmlFor="canon-tag-name">{copy.name}</FieldLabel>
          <Input id="canon-tag-name" value={name} maxLength={32} onChange={event => setName(event.target.value)} /></Field>}
        {action === "color" && <TagColorSwatches value={color} onValueChange={setColor} labels={copy.colors} ariaLabel={copy.color} />}
      </DialogForm>
      </Stack>
    </DialogContent>
  </Dialog>;
}
