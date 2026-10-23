import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Tooltip } from "@/butler-ds";
export function CanonFormFooter({ title, busy, submitLabel, onCancel }: {
  title: string; busy: boolean; submitLabel: string; onCancel: () => void;
}) {
  return <ButtonContainer size="sm" justify="end">
    <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>{appCopy.canon.cancel}</Button>
    <Tooltip label={!title.trim() ? appCopy.canon.titleRequired : undefined}>
      <Button size="sm" type="submit" disabled={busy || !title.trim()}>{submitLabel}</Button>
    </Tooltip>
  </ButtonContainer>;
}
