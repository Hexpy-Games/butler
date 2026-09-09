import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogHeader, DialogTitle, Stack, Textarea, Typo, IconButton, Pencil } from "@/butler-ds";
import styles from "./ProjectInformation.module.css";

export function ProjectDescription({ projectId, description, revision, onUpdated }: {
  projectId: string; description: string | null; revision: number; onUpdated: () => void;
}) {
  useAppLocale();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/dashboard/preferences`, {
        method: "PATCH", body: JSON.stringify({ expectedRevision: revision, description: draft }),
      });
      setOpen(false); onUpdated();
    } catch (error) { notifyError(error, appCopy.feedback.dashboardRetry); }
    finally { setSaving(false); }
  };
  return <Stack gap="sm">
    <div className={styles.description}>
      <Typo.Body className={styles.summary}>{description || appCopy.projectSignpost.description}</Typo.Body>
      <IconButton label={appCopy.projectSignpost.editDescription} onClick={() => { setDraft(description ?? ""); setOpen(true); }}><Pencil /></IconButton>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{appCopy.projectSignpost.description}</DialogTitle></DialogHeader>
        <Textarea aria-label={appCopy.projectSignpost.description} value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} />
        <ButtonContainer size="sm">
          <Button size="sm" variant="borderless" onClick={() => setOpen(false)}>{appCopy.common.cancel}</Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>{appCopy.common.save}</Button>
        </ButtonContainer>
      </DialogContent>
    </Dialog>
  </Stack>;
}
