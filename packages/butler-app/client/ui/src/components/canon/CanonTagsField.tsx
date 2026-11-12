import type { ReactNode } from "react";
import type { EpicTag } from "@/app/canonApi.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Box, Field, FieldLabel, Stack, Tag } from "@/butler-ds";
import { CanonTagChooser } from "./CanonTagChooser.tsx";
import { useCanonTagEditor } from "./useCanonTagEditor.tsx";
export function CanonTagsField({ projectId, value, onChange, disabled, row = false }: {
  projectId: string; value: EpicTag[]; onChange: (tags: EpicTag[]) => void; disabled?: boolean; row?: boolean;
}) {
  useAppLocale();
  const copy = appCopy.canon.tags;
  // A created (or same-name existing) tag is attached; a deleted tag leaves the open form too, except the property row, whose epic refreshes.
  const { tags, busy, dialog, onCreate, onManage } = useCanonTagEditor(projectId, {
    onCreated: tag => onChange([...selected.filter(item => item.id !== tag.id), tag]),
    onDeleted: tag => { if (!row) onChange(selected.filter(item => item.id !== tag.id)); },
  });
  const selected = value.map(tag => tags.find(item => item.id === tag.id) ?? tag);
  const chooser = (chips?: ReactNode) => <CanonTagChooser tags={tags} value={selected.map(tag => tag.id)} disabled={disabled || busy} chips={chips} align={row ? "end" : "start"}
    onChange={ids => onChange(ids.map(id => tags.find(tag => tag.id === id) ?? selected.find(tag => tag.id === id)!))}
    onCreate={onCreate} onManage={onManage} />;
  // Property row: the chips are the picker trigger; rename/recolor/delete stay on each picker row's pencil.
  if (row) return <Box minWidth="0" shrink data-test-class="canon-tags-field">
    {chooser(selected.length ? <Stack inline align="row" cross="center" gap="xs" wrap data-test-class="canon-tags">
      {selected.map(tag => <Tag key={tag.id} tone={tag.color} size="sm">{tag.name}</Tag>)}</Stack> : appCopy.canon.none)}
    {dialog}
  </Box>;
  return <Field data-test-class="canon-tags-field">
    <FieldLabel>{copy.label}</FieldLabel>
    <Stack align="row" gap="xs" wrap data-test-class="canon-tags">
      {selected.map(tag => <Tag key={tag.id} tone={tag.color} size="sm"
        onRemove={disabled || busy ? undefined : () => onChange(selected.filter(item => item.id !== tag.id))}
        removeLabel={copy.removeTag(tag.name)}>{tag.name}</Tag>)}
    </Stack>
    {chooser()}
    {dialog}
  </Field>;
}
