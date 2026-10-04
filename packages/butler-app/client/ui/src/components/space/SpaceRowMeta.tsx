import { useAppLocale } from "@/app/copy.ts";
import { appCopy, interfaceProgressLabel } from "@/app/copy.ts";
import { Stack, Typo } from "@/butler-ds";
import { useOrganization } from "@/app/space/organization";
import { spaceActivity } from "@/app/space/activity";
import type { SpaceRowData } from "@/app/space/projection";
import { relativeAge } from "@/app/utils";
import { useMinuteClock } from "@/app/space/minute-clock";

export function SpaceRowMeta({ row }: { row: SpaceRowData }) {
  const locale = useAppLocale();
  const tab = useOrganization(s => s.tab);
  useMinuteClock(tab === "recent");
  const status = row.session?.attention_required ? appCopy.space.attention : interfaceProgressLabel({
    safe_label: row.session?.safe_status_label ?? "",
    interface_content: row.session?.safe_status_content,
    interface_label_key: row.session?.safe_status_label_key,
    interface_label_parameters: row.session?.safe_status_label_parameters,
  }) || (spaceActivity(row.session) === "working" ? appCopy.space.working : appCopy.space.attention);
  const progress = row.session?.work_progress;
  const progressText = progress ? ` · ${Math.min(progress.total, progress.completed + 1)}/${progress.total}` : "";
  return (
    <Stack as="span" align="row" cross="baseline" justify="between" gap="sm">
      <Typo.Caption title={row.location} tone="secondary" grow basis="0" minWidth="0" truncate>{row.location}</Typo.Caption>
      {tab === "recent" ? (
        <Typo.Caption as="time" dateTime={row.updatedAt} numeric="tabular" tone="secondary" title={new Date(row.updatedAt).toLocaleString(locale)} wrap="nowrap">
          {relativeAge(row.updatedAt)}
        </Typo.Caption>
      ) : (
        <Stack as="span" inline align="row" gap="none" minWidth="0" maxWidth="3/5" title={`${status}${progressText}`}>
          <Typo.Caption tone="secondary" truncate>{status}</Typo.Caption>
          {progressText && <Typo.Caption tone="secondary" wrap="pre" shrink={false}>{progressText}</Typo.Caption>}
        </Stack>
      )}
    </Stack>
  );
}
