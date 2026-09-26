import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Grid, type GridColumnPreset } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "../ScrollArea";
import { SurfacePanel } from "../SurfacePanel";
import styles from "./KanbanBoard.module.css";

export interface KanbanBoardProps extends DsBaseProps<HTMLAttributes<HTMLElement>> {
  children: ReactNode;
  /** One column per lane (default four). */
  columns?: GridColumnPreset;
}

/** Lanes side by side; each lane is a KanbanLane. */
export function KanbanBoard({ children, columns = "4", className, ...props }: KanbanBoardProps) {
  return (
    <Grid columns={columns} gap="md" className={dsClass(styles.board, className)} {...props}>
      {children}
    </Grid>
  );
}

export interface KanbanLaneProps {
  title: ReactNode;
  children: ReactNode;
}

/** A fixed-height lane (`--kanban-lane-height`) whose cards scroll under the title. */
export function KanbanLane({ title, children }: KanbanLaneProps) {
  return (
    <SurfacePanel elevation="none" className={dsClass(styles.lane)} data-slot="kanban-lane">
      <Stack gap="sm" className={dsClass(styles.laneInner)}>
        <Typo.PanelSectionTitle>{title}</Typo.PanelSectionTitle>
        <ScrollArea className={dsClass(styles.laneScroller)}>
          <Stack gap="sm">{children}</Stack>
        </ScrollArea>
      </Stack>
    </SurfacePanel>
  );
}
