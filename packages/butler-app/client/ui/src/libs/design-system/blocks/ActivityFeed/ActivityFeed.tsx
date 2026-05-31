import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { SurfacePanel } from "../SurfacePanel";
import styles from "./ActivityFeed.module.css";

export interface ActivityFeedItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
}

export interface ActivityFeedProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title"
> {
  title?: ReactNode;
  items: ActivityFeedItem[];
  emptyLabel?: ReactNode;
  surface?: "transparent" | "composer";
}

export function ActivityFeed({
  title,
  items,
  emptyLabel = "No recent activity",
  className,
  surface = "transparent",
  ...props
}: ActivityFeedProps) {
  return (
    <SurfacePanel
      elevation="none"
      className={cn(
        styles.feed,
        surface === "composer" && styles.composer,
        className,
      )}
      {...props}
    >
      <Stack gap="sm">
        {title ? <Typo.PanelSectionTitle className={styles.feedTitle}>{title}</Typo.PanelSectionTitle> : null}
        {items.length === 0 ? (
          <Typo.Caption className={styles.empty}>{emptyLabel}</Typo.Caption>
        ) : (
          <Stack gap="xs">
            {items.map((item) => (
              <div className={styles.item} key={item.id}>
                {item.icon ? <span className={styles.icon} data-slot="activity-feed-icon">{item.icon}</span> : null}
                <Stack gap="xs" className={styles.body}>
                  <Stack
                    align="row"
                    justify="between"
                    gap="sm"
                    cross="start"
                    className={styles.header}
                  >
                    <Typo.Body className={styles.title} data-slot="activity-feed-title">{item.title}</Typo.Body>
                    {item.meta ? <Typo.Caption className={styles.meta}>{item.meta}</Typo.Caption> : null}
                  </Stack>
                  {item.description ? (
                    <Typo.Caption className={styles.description}>{item.description}</Typo.Caption>
                  ) : null}
                </Stack>
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}
