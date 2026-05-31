import { useState } from "react";
import { DisclosureRow, ListRow, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import {
  activityIcon,
  toolchainSummaryLabel,
  toolchainDetailLabel,
  activityDetailId,
} from "./toolchainUtils";

export function ToolchainDisclosureRow({ row }: { row: ProgressRow }) {
  const [expanded, setExpanded] = useState(false);
  const detailRows = row.safe_detail_rows ?? [];
  const hasDetails = detailRows.length > 0;
  const label = toolchainSummaryLabel(row);
  const detailsId = activityDetailId(row.id);

  if (!hasDetails) {
    return (
      <div
        data-test-class="turn-activity-collapsed-row turn-work-tool-row"
      >
        <ListRow icon={activityIcon(row)} title={label} />
      </div>
    );
  }

  return (
    <div
      data-test-class="turn-work-tool-row turn-work-tool-disclosure"
    >
      <DisclosureRow
        controlsId={detailsId}
        icon={activityIcon(row)}
        open={expanded}
        title={label}
        onToggle={() => setExpanded((value) => !value)}
      >
        <Stack
          aria-label={appCopy.conversation.work.detailsRegionLabel(label)}
          data-test-class="turn-activity-details turn-work-tool-detail-list"
          id={detailsId}
          role="region"
          gap="xs"
        >
          {detailRows.map((detail, detailIndex) => (
            <Typo.Caption key={`${detail.id}:${detailIndex}`}>
              {toolchainDetailLabel(detail, row)}
            </Typo.Caption>
          ))}
        </Stack>
      </DisclosureRow>
    </div>
  );
}
