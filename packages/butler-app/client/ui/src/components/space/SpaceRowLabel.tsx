import { Typo } from "@/butler-ds";
import { useOrganization } from "@/app/space/organization";
import { spaceActivity } from "@/app/space/activity";
import type { SpaceRowData } from "@/app/space/projection";
import { relativeAge } from "@/app/utils";
import { useMinuteClock } from "@/app/space/minute-clock";
import styles from "./SpaceSidebar.module.css";
import interaction from "./SpaceInteractions.module.css";
export function SpaceRowLabel({
  row,
  flat,
}: {
  row: SpaceRowData;
  flat: boolean;
}) {
  const tab = useOrganization((s) => s.tab);
  useMinuteClock(flat && tab === "recent");
  return (
    <span className={styles.flatLabel}>
      <span
        className={flat ? interaction.clampedTitle : interaction.singleTitle}
        title={row.title}
      >
        {row.title}
      </span>
      {flat && (
        <span className={interaction.rowMeta}>
          <Typo.Caption className={styles.muted} title={row.location}>
            {row.location}
          </Typo.Caption>
          {tab === "recent" ? (
            <time
              dateTime={row.updatedAt}
              title={new Date(row.updatedAt).toLocaleString()}
            >
              {relativeAge(row.updatedAt)}
            </time>
          ) : (
            <Typo.Caption className={interaction.statusText}>
              {row.session?.safe_status_label ||
                (spaceActivity(row.session) === "working"
                  ? "작업 중"
                  : "확인 필요")}
              {row.session?.work_progress && ` · ${Math.min(row.session.work_progress.total, row.session.work_progress.completed + 1)}/${row.session.work_progress.total}`}
            </Typo.Caption>
          )}
        </span>
      )}
    </span>
  );
}
