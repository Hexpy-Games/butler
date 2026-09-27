import { Typo } from "@/butler-ds";
import type { SpaceRowData } from "@/app/space/projection";
export function SpaceRowLabel({
  row,
  flat,
}: {
  row: SpaceRowData;
  flat: boolean;
}) {
  return (
    flat ? (
      <Typo.Text lineClamp={2} wrap="anywhere" title={row.title}>{row.title}</Typo.Text>
    ) : (
      <Typo.Text truncate title={row.title}>{row.title}</Typo.Text>
    )
  );
}
