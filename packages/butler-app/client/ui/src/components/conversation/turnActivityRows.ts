import type { ProgressRow } from "@/app/types.ts";

export function latestPublicActivity(
  rows: ProgressRow[],
): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      row &&
      row.kind === "message" &&
      row.state === "running" &&
      !row.work_block_id &&
      row.safe_label.trim().length > 0
    ) {
      return row;
    }
  }
  return undefined;
}
