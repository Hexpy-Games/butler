import { useAppLocale } from "@/app/copy.ts";
import { appCopy, interfaceProgressLabel } from "@/app/copy.ts";
import { Typo } from "@/butler-ds";
import { useOrganization } from "@/app/space/organization";
import { spaceActivity } from "@/app/space/activity";
import type { SpaceRowData } from "@/app/space/projection";
import { relativeAge } from "@/app/utils";
import { useMinuteClock } from "@/app/space/minute-clock";
import interaction from "./SpaceInteractions.module.css";

export function SpaceRowMeta({ row }: { row: SpaceRowData }) {
  const locale = useAppLocale();
  const tab = useOrganization(s => s.tab);
  useMinuteClock(tab === "recent");
  const status = interfaceProgressLabel({
    safe_label: row.session?.safe_status_label ?? "",
    interface_content: row.session?.safe_status_content,
    interface_label_key: row.session?.safe_status_label_key,
    interface_label_parameters: row.session?.safe_status_label_parameters,
  }) || (spaceActivity(row.session) === "working" ? appCopy.space.working : appCopy.space.attention);
  const progress = row.session?.work_progress;
  const progressText = progress ? ` · ${Math.min(progress.total, progress.completed + 1)}/${progress.total}` : "";
  return (
    <span className={interaction.rowMeta}>
      <Typo.Caption title={row.location}>{row.location}</Typo.Caption>
      {tab === "recent" ? (
        <time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString(locale)}>
          {relativeAge(row.updatedAt)}
        </time>
      ) : (
        <Typo.Caption className={interaction.statusText} title={`${status}${progressText}`}>
          <span className={interaction.statusLabel}>{status}</span>
          {progressText && <span className={interaction.statusProgress}>{progressText}</span>}
        </Typo.Caption>
      )}
    </span>
  );
}
