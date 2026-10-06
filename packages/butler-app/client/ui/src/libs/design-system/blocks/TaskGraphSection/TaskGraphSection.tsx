import type { ReactNode } from "react";
import type { TaskGraphStatus } from "../../lib/taskGraphLayout";
import { Box } from "../../components/Box";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "../DisclosureRow";
import { EmptyLine } from "../EmptyLine";
import { InspectorInset } from "../InspectorShell";
import { Section } from "../../components/Section";
import { TaskGraphStatusIcon } from "../TaskGraphCard";

export interface TaskGraphSectionProps {
  /** Stable id; the open region gets `task-graph-<id>` for aria-controls. */
  graphId: string;
  /** The plan's goal. */
  title: string;
  /** Rolled-up state of the graph (rollupTaskGraphStatus). */
  status: TaskGraphStatus;
  /** Counts, e.g. "7/16 done · 1 failed". */
  meta?: ReactNode;
  open: boolean;
  onToggle?: () => void;
  /** False for the only graph: no row, the content is always shown. */
  collapsible?: boolean;
  /** The graph (TaskGraphCanvas) and, when it owns the selection, TaskGraphDetail. */
  children: ReactNode;
}

/**
 * One graph in the Tasks tab. A DisclosureRow on its default selection surface
 * (trigger inset inside the row box, hover fill, flat fill when open), rendered
 * without children: the graph sits below the row so cards keep the inspector
 * inset instead of the row panel's title-column indent.
 */
export function TaskGraphSection({ graphId, title, status, meta, open, onToggle, collapsible = true, children }: TaskGraphSectionProps) {
  const isOpen = !collapsible || open;
  const regionId = `task-graph-${graphId}`;
  return (
    <Stack gap="none" data-test-class="task-graph-group" data-graph-id={graphId} data-open={isOpen ? "true" : "false"}>
      {collapsible ? (
        <InspectorInset>
          <DisclosureRow title={title} meta={meta} icon={<TaskGraphStatusIcon status={status} />} open={isOpen} controlsId={regionId} onToggle={onToggle} />
        </InspectorInset>
      ) : null}
      {isOpen ? (
        <Box paddingY={collapsible ? "sm" : "none"}>
          <Stack gap="md" id={regionId}>{children}</Stack>
        </Box>
      ) : null}
    </Stack>
  );
}

export interface TaskGraphPanelProps {
  title: string;
  icon?: ReactNode;
  /** With one graph: its goal, shown under the title. */
  description?: ReactNode;
  /** Right of the title: one graph's counts, or "6 graphs · 2 running". */
  headerMeta?: ReactNode;
  /** Shown when there are no graphs (children empty). */
  emptyLabel: string;
  empty?: boolean;
  /** TaskGraphSection elements, in display order. */
  children?: ReactNode;
}

/**
 * The Tasks tab body: an inset Section header, then the graph sections. The
 * header-to-content space is the Section's own gap (lg); folded sections sit
 * xs apart (the DS row rhythm).
 */
export function TaskGraphPanel({ title, icon, description, emptyLabel, empty = false, children, headerMeta }: TaskGraphPanelProps) {
  return (
    <Stack gap="none" data-test-class="task-graph-section">
      <InspectorInset>
        <Section
          title={title}
          icon={icon}
          description={description}
          actions={headerMeta ? <Typo.Caption tone="tertiary" numeric="tabular">{headerMeta}</Typo.Caption> : undefined}
          gap="sm"
        >
          {empty ? <EmptyLine message={emptyLabel} /> : null}
        </Section>
      </InspectorInset>
      {empty ? null : <Stack gap="xs">{children}</Stack>}
    </Stack>
  );
}
