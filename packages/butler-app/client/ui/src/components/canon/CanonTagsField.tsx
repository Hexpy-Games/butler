import { useState, type ReactNode } from "react";
import { createCanonTag, type CanonTag, type CanonTagExists, type EpicTag } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Box, Field, FieldLabel, Stack, Tag } from "@/butler-ds";
import { useCanonTags } from "./useCanonTags.ts";
import { CanonTagChooser } from "./CanonTagChooser.tsx";
import { CanonTagManageDialog, type TagAction } from "./CanonTagManageDialog.tsx";
import { canonWriteFailure } from "./canonFeedback.ts";
export function CanonTagsField({ projectId, value, onChange, disabled, row = false }: {
  projectId: string; value: EpicTag[]; onChange: (tags: EpicTag[]) => void; disabled?: boolean; row?: boolean;
}) {
  useAppLocale();
  const copy = appCopy.canon.tags;
  const { tags, refresh } = useCanonTags(projectId);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState<{ tag: CanonTag; action: TagAction } | null>(null);
  const selected = value.map(tag => tags.find(item => item.id === tag.id) ?? tag);
  const create = async (name: string) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      // New tags start blue. Choosing another swatch is a revision-checked tag edit.
      // An existing tag with the same name is selected as it is.
      let tag: CanonTag, created = true;
      try { tag = await createCanonTag(projectId, { name, color: "blue" }); }
      catch (error) {
        if (apiErrorCode(error) !== "tag_exists") throw error;
        tag = (error as CanonTagExists).existing; created = false;
      }
      onChange([...selected.filter(item => item.id !== tag.id), tag]);
      await refresh();
      if (created) setManage({ tag, action: "color" });
    } catch (error) { await canonWriteFailure(error, refresh); }
    finally { setBusy(false); }
  };
  const chooser = (chips?: ReactNode) => <CanonTagChooser tags={tags} value={selected.map(tag => tag.id)} disabled={disabled || busy} chips={chips} align={row ? "end" : "start"}
    onChange={ids => onChange(ids.map(id => tags.find(tag => tag.id === id) ?? selected.find(tag => tag.id === id)!))}
    onCreate={name => void create(name)} onManage={(tag, action) => setManage({ tag, action })} />;
  const dialog = manage && <CanonTagManageDialog key={`${manage.tag.id}-${manage.action}`} {...manage} onClose={() => setManage(null)} onRefresh={refresh}
    onDeleted={() => { if (!row) onChange(selected.filter(tag => tag.id !== manage.tag.id)); }} />;
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
