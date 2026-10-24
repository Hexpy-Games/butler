import { useState } from "react";
import { createCanonTag, type CanonTag, type CanonTagExists, type EpicTag } from "@/app/canonApi.ts";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Field, FieldLabel, OverflowActionMenu, Stack, Tag } from "@/butler-ds";
import { useCanonTags } from "./useCanonTags.ts";
import { CanonTagChooser } from "./CanonTagChooser.tsx";
import { CanonTagManageDialog, type TagAction } from "./CanonTagManageDialog.tsx";
import { canonWriteFailure } from "./canonFeedback.ts";
export function CanonTagsField({ projectId, value, onChange, disabled }: {
  projectId: string; value: EpicTag[]; onChange: (tags: EpicTag[]) => void; disabled?: boolean;
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
  return <Field data-test-class="canon-tags-field">
    <FieldLabel>{copy.label}</FieldLabel>
    <Stack align="row" gap="xs" wrap>
      {selected.map(tag => <Stack key={tag.id} align="row" cross="center" gap="none">
        <Tag tone={tag.color} size="sm" onRemove={disabled || busy ? undefined : () => onChange(selected.filter(item => item.id !== tag.id))}
          removeLabel={copy.removeTag(tag.name)}>{tag.name}</Tag>
        {!disabled && !busy && tags.some(item => item.id === tag.id) && <OverflowActionMenu label={copy.menu(tag.name)} items={[
          { label: copy.rename, onSelect: () => setManage({ tag: tags.find(item => item.id === tag.id)!, action: "rename" }) },
          { label: copy.recolor, onSelect: () => setManage({ tag: tags.find(item => item.id === tag.id)!, action: "color" }) },
          { label: copy.remove, variant: "destructive", onSelect: () => setManage({ tag: tags.find(item => item.id === tag.id)!, action: "delete" }) },
        ]} />}
      </Stack>)}
    </Stack>
    <CanonTagChooser tags={tags} value={selected.map(tag => tag.id)} disabled={disabled || busy}
      onChange={ids => onChange(ids.map(id => tags.find(tag => tag.id === id) ?? selected.find(tag => tag.id === id)!))}
      onCreate={name => void create(name)} />
    {manage && <CanonTagManageDialog key={`${manage.tag.id}-${manage.action}`} {...manage} onClose={() => setManage(null)} onRefresh={refresh}
      onDeleted={() => onChange(selected.filter(tag => tag.id !== manage.tag.id))} />}
  </Field>;
}
