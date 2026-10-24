import { appCopy } from "@/app/copy.ts";
import type { EpicTag } from "@/app/canonApi.ts";
import { Stack, Tag } from "@/butler-ds";
export function CanonTagList({ tags, limit, onRemove }: {
  tags: EpicTag[]; limit?: number; onRemove?: (id: string) => void;
}) {
  if (!tags.length) return null;
  const shown = limit ? tags.slice(0, limit) : tags;
  return <Stack align="row" gap="xs" wrap data-test-class="canon-tags">
    {shown.map(tag => <Tag key={tag.id} size="sm" tone={tag.color}
      onRemove={onRemove ? () => onRemove(tag.id) : undefined} removeLabel={appCopy.canon.tags.removeTag(tag.name)}>{tag.name}</Tag>)}
    {limit && tags.length > limit && <Tag size="sm">+{tags.length - limit}</Tag>}
  </Stack>;
}
