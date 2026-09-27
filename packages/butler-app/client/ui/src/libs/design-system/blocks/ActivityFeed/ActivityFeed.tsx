import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SurfacePanel } from "../SurfacePanel";
import styles from "./ActivityFeed.module.css";
import { dsClass } from "../../lib/internal";

export interface ActivityFeedItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
}

export interface ActivityFeedProps extends Omit<
  DsBaseProps<HTMLAttributes<HTMLDivElement>>,
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
      className={dsClass(styles.feed, surface === "composer" && styles.composer, className)}
      {...props}
    >
      <Stack gap="sm">
        {title ? <Typo.PanelSectionTitle className={dsClass(styles.feedTitle)}>{title}</Typo.PanelSectionTitle> : null}
        {items.length === 0 ? (
          <Typo.Caption className={dsClass(styles.empty)}>{emptyLabel}</Typo.Caption>
        ) : (
          <Stack gap="xs">
            {items.map((item) => (
              <div className={styles.item} key={item.id}>
                {item.icon ? <span className={styles.icon} data-slot="activity-feed-icon">{item.icon}</span> : null}
                <Stack gap="xs" className={dsClass(styles.body)}>
                  <Stack
                    align="row"
                    justify="between"
                    gap="sm"
                    cross="start"
                    className={dsClass(styles.header)}
                  >
                    <Typo.Body className={dsClass(styles.title)} data-slot="activity-feed-title">{item.title}</Typo.Body>
                    {item.meta ? <Typo.Caption className={dsClass(styles.meta)}>{item.meta}</Typo.Caption> : null}
                  </Stack>
                  {item.description ? (
                    <Typo.Caption className={dsClass(styles.description)}>{item.description}</Typo.Caption>
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
