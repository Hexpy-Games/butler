import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SurfacePanel } from "../SurfacePanel";
import {
  WorkActivityToolGroup,
  type WorkActivityToolItem,
} from "./WorkActivityToolGroup";
import styles from "./WorkActivityBlock.module.css";
import { dsClass } from "../../lib/internal";

export type { WorkActivityToolItem };

export interface WorkActivityBlockProps
  extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  running?: boolean;
  connected?: boolean;
  density?: "normal" | "compact";
  tools?: WorkActivityToolItem[];
}

export function WorkActivityBlock({
  title,
  description,
  icon,
  running = false,
  connected = false,
  density = "normal",
  tools = [],
  className,
  ...props
}: WorkActivityBlockProps) {
  return (
    <SurfacePanel
      className={dsClass(styles.block, density === "compact" && styles.compact, running && styles.running, connected && styles.connected, className)}
      elevation="none"
      data-connected={connected || undefined}
      data-test-class={`turn-work-block${running ? " turn-work-block-running" : ""}`}
      {...props}
    >
      <Stack gap={density === "compact" ? "xs" : "sm"}>
        <div className={styles.header}>
          {icon ? (
            <span className={styles.icon} data-slot="work-activity-icon">
              {icon}
            </span>
          ) : (
            <span
              className={styles.marker}
              data-slot="work-activity-marker"
              aria-hidden="true"
            />
          )}
          <Typo.Body
            as="span"
            className={dsClass(styles.title)}
            data-test-class="turn-work-block-header"
          >
            {title}
          </Typo.Body>
        </div>
        {description ? (
          <Typo.Body
            as="div"
            className={dsClass(styles.description)}
            data-slot="work-activity-description"
          >
            {description}
          </Typo.Body>
        ) : null}
        {tools.length > 0 ? (
          <div className={styles.tools} data-test-class="turn-work-toolchain">
            <WorkActivityToolGroup tools={tools} />
          </div>
        ) : null}
      </Stack>
    </SurfacePanel>
  );
}
