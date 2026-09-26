import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { Grid, type GridColumnPreset } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "../ScrollArea";
import { SurfacePanel } from "../SurfacePanel";
import styles from "./KanbanBoard.module.css";

export interface KanbanBoardProps extends DsBaseProps<HTMLAttributes<HTMLElement>> {
  children: ReactNode;
  /** One column per lane (default four). Ignored with `scroll`. */
  columns?: GridColumnPreset;
  /**
   * Keep every lane in one row at least `--kanban-lane-min-width` wide; the
   * board scrolls sideways with the x scroll-edge fade instead of wrapping.
   */
  scroll?: boolean;
}

/** Lanes side by side; each lane is a KanbanLane (or any lane surface). */
export function KanbanBoard({ children, columns = "4", scroll = false, className, ...props }: KanbanBoardProps) {
  const edgesRef = useScrollEdges("x", scroll);
  return (
    <Grid columns={columns} gap="md" className={dsClass(styles.board, className)}
      data-scroll={scroll ? "true" : undefined} ref={scroll ? edgesRef : undefined} {...props}>
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
