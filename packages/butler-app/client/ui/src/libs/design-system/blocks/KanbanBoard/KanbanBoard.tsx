import { useLayoutEffect, useMemo, useRef, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { Grid, type GridColumnPreset } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "../ScrollArea";
import { SurfacePanel } from "../SurfacePanel";
import { anchorSide, KanbanLaneContext, useKanbanScope } from "./kanbanContext";
import type { KanbanLaneLayout } from "./kanbanDragModel";
import { useKanbanSlot } from "./useKanbanSlot";
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

/** Lanes side by side; each lane is a KanbanLane (or another lane surface). */
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
  /** Drop target id inside a KanbanDragScope; `onMove` reports it. Lanes without it take no cards. */
  laneId?: string;
  /** Lane name for drag announcements; defaults to `title` when it is text. */
  label?: string;
  /**
   * `fixed` (default): `--kanban-lane-height`, cards scroll under the title.
   * `content`: grows with its cards from `--kanban-lane-min-height` (status lanes of a board).
   */
  height?: "fixed" | "content";
  /** `grid`: cards wrap in columns at least `--kanban-card-min-width` wide (one wide lane, such as a backlog). */
  layout?: KanbanLaneLayout;
}

/** A lane of cards; with `laneId` inside a KanbanDragScope it takes dropped KanbanCards. */
export function KanbanLane({ title, children, laneId, label, height = "fixed", layout = "list" }: KanbanLaneProps) {
  const scope = useKanbanScope();
  const droppable = Boolean(scope && laneId);
  const list = useRef<HTMLDivElement | null>(null);
  const laneLabel = label ?? (typeof title === "string" ? title : laneId ?? "");
  const view = scope?.view;
  const startSide = droppable && view ? anchorSide(view, laneId!, null) : null;
  useKanbanSlot(list, startSide, layout === "list" ? (view?.slot ?? 0) : 0, Boolean(view?.activeId));
  useLayoutEffect(() => {
    const element = list.current?.closest<HTMLElement>('[data-slot="kanban-lane"]');
    if (!scope || !laneId || !element) return;
    scope.registry.lanes.set(laneId, { element, layout, label: laneLabel });
    return () => {
      if (scope.registry.lanes.get(laneId)?.element === element) scope.registry.lanes.delete(laneId);
    };
  }, [scope, laneId, layout, laneLabel]);
  const context = useMemo(() => (laneId ? { laneId, layout } : null), [laneId, layout]);

  const target = droppable && view?.target?.laneId === laneId;
  const cards = droppable || height === "content" || layout === "grid"
    ? <div ref={list} className={styles.list} data-layout={layout} data-drop={startSide ?? undefined}>{children}</div>
    : <Stack gap="sm">{children}</Stack>;
  return (
    <SurfacePanel elevation="none" className={dsClass(styles.lane)} data-slot="kanban-lane" data-height={height}
      data-drop-target={target ? "true" : undefined}>
      <KanbanLaneContext.Provider value={context}>
        <Stack gap="sm" className={dsClass(styles.laneInner)}>
          <Typo.PanelSectionTitle>{title}</Typo.PanelSectionTitle>
          {height === "content" ? cards : <ScrollArea className={dsClass(styles.laneScroller)}>{cards}</ScrollArea>}
        </Stack>
      </KanbanLaneContext.Provider>
    </SurfacePanel>
  );
}
