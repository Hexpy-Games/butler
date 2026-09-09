import type { SpaceRowData } from "@/app/space/projection";
import interaction from "./SpaceInteractions.module.css";
export function SpaceRowLabel({
  row,
  flat,
}: {
  row: SpaceRowData;
  flat: boolean;
}) {
  return (
      <span
        className={flat ? interaction.clampedTitle : interaction.singleTitle}
        title={row.title}
      >
        {row.title}
      </span>
  );
}
