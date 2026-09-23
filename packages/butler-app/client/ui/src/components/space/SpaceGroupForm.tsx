import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useState } from "react";
import {
  Button,
  ButtonContainer,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Stack,
} from "@/butler-ds";
import { useOrganization, type SpaceDialog } from "@/app/space/organization";

export function SpaceGroupForm({
  dialog,
}: {
    dialog: Extract<SpaceDialog, { kind: "create" | "rename" | "group" }>;
}) {
  useAppLocale();
  const [title, setTitle] = useState(
    dialog.kind === "rename" ? dialog.title : "",
  );
  const pending = useOrganization((s) => s.pending);
  const mutate = useOrganization((s) => s.mutate);
  return (
    <form
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        void mutate(
          dialog.kind === "create"
            ? {
                action: "create",
                title: title.trim(),
                parentKey: dialog.parentKey,
              }
            : dialog.kind === "group"
              ? {
                  action: "group",
                  title: title.trim(),
                  sourceKey: dialog.sourceKey,
                  targetKey: dialog.targetKey,
                }
            : {
                action: "rename",
                groupId: dialog.groupId,
                title: title.trim(),
              },
        );
      }}
    >
      <Stack gap="4">
        <DialogHeader>
          <DialogTitle>
            {dialog.kind === "rename" ? appCopy.space.renameGroup : appCopy.space.createGroup}
          </DialogTitle>
          <DialogDescription>
            {appCopy.space.groupDescription}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="space-group-title">{appCopy.space.groupName}</FieldLabel>
          <Input
            id="space-group-title"
            autoFocus
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <ButtonContainer size="sm" justify="end">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={pending}
            onClick={() => useOrganization.getState().setDialog(null)}
          >
            {appCopy.space.cancel}</Button>
          <Button size="sm" type="submit" disabled={pending || !title.trim()}>
            {pending ? `${appCopy.space.save}…` : appCopy.space.save}</Button>
        </ButtonContainer>
      </Stack>
    </form>
  );
}
