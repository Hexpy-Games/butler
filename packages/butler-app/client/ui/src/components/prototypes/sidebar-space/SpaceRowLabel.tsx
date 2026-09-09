import { Typo } from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { locationOf } from "@/app/prototypes/sidebar-space/sample-data";
import { relativeActivity } from "@/app/prototypes/sidebar-space/row-details";
import styles from "./SpaceMockup.module.css";
import interaction from "./SidebarInteractions.module.css";

export function SpaceRowLabel({ id, flat }: { id: string; flat: boolean }) {
  const items = useMock((s) => s.items);
  const view = useMock((s) => s.view);
  const item = items.find((row) => row.id === id)!;
  return (
    <span className={styles.flatLabel}>
      <span className={interaction.titleLine}>
        <span
          className={flat ? interaction.clampedTitle : interaction.singleTitle}
          title={item.title}
        >
          {item.title}
        </span>
      </span>
      {flat && (
        <span className={interaction.rowMeta}>
          <Typo.Caption
            className={styles.muted}
            title={locationOf(item, items)}
          >
            {locationOf(item, items)}
          </Typo.Caption>
          {view === "running" && (
            <Typo.Caption className={interaction.statusText}>
              {item.status}
            </Typo.Caption>
          )}
          {view === "recent" && item.updatedAt !== undefined && (
            <time
              dateTime={new Date(item.updatedAt).toISOString()}
              title={new Date(item.updatedAt).toLocaleString("ko")}
            >
              {relativeActivity(item.updatedAt)}
            </time>
          )}
        </span>
      )}
    </span>
  );
}
