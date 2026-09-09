import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, DialogDescription, DialogHeader, DialogTitle, Stack } from "@/butler-ds";
import { useOrganization, type SpaceDialog } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";

export function SpaceRelocationForm({ dialog, rows }: { dialog: Extract<SpaceDialog, { kind: "relocate" }>; rows: Map<string, SpaceRowData> }) {
  useAppLocale();
  const pending = useOrganization(s => s.pending);
  const source = rows.get(dialog.sourceKey);
  const target = dialog.targetKey ? rows.get(dialog.targetKey) : undefined;
  return <Stack gap="4">
    <DialogHeader>
      <DialogTitle>{appCopy.space.relocationTitle}</DialogTitle>
      <DialogDescription>
        {appCopy.space.relocationDescription(source?.title ?? "", target?.title ?? appCopy.space.root)}
      </DialogDescription>
    </DialogHeader>
    <ButtonContainer size="sm" justify="end">
      <Button variant="secondary" disabled={pending} onClick={() => useOrganization.getState().setDialog(null)}>{appCopy.space.cancel}</Button>
      <Button disabled={pending || !source?.session} onClick={() => {
        if (source?.session) void useOrganization.getState().mutate({ action: "relocate", sessionId: source.session.id,
          targetKey: dialog.targetKey, position: dialog.position, operationId: dialog.operationId });
      }}>{pending ? appCopy.space.moving : appCopy.space.move}</Button>
    </ButtonContainer>
  </Stack>;
}
