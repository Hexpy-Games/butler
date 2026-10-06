import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import type { TaskGraphStatus } from "../../lib/taskGraphLayout";
import { Card } from "../../components/Card";
import { Circle, CircleAlert, CircleX, Eye, ICON_SIZE, Minus } from "../../components/Icons";
import { IconSlot } from "../../components/IconSlot";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { RollingStatusLine } from "../../components/RollingStatusLine";
import { RollingSwap } from "../../components/RollingSwap";
import { Stack } from "../../components/Stack";
import { Tag, type TagTone } from "../../components/Tag";
import { Typo } from "../../components/Typo";


const TONE: Record<TaskGraphStatus, TagTone> = {
  pending: "neutral", running: "accent", review: "accent", done: "neutral",
  failed: "danger", blocked: "warning", cancelled: "neutral", paused: "neutral",
};

/** Tag tone for a task status (accent while live, danger failed, warning blocked). */
export function taskGraphStatusTone(status: TaskGraphStatus): TagTone {
  return TONE[status];
}

/** One glyph per status. Running and done share LoadingIndicator, so running -> done draws the check. */
export function TaskGraphStatusIcon({ status }: { status: TaskGraphStatus }) {
  switch (status) {
    case "running": return <LoadingIndicator state="loading" size={ICON_SIZE.md} />;
    case "done": return <LoadingIndicator state="done" size={ICON_SIZE.md} />;
    case "review": return <Eye size="md" />;
    case "failed": return <Typo.Text tone="danger"><CircleAlert size="md" /></Typo.Text>;
    case "blocked": return <Typo.Text tone="warning"><CircleAlert size="md" /></Typo.Text>;
    case "cancelled": return <CircleX size="md" />;
    case "paused": return <Minus size="md" />;
    default: return <Circle size="md" />;
  }
}

/** The live step line of a running task: one line that rolls when the step changes. */
export function TaskGraphStepLine({ step }: { step: string }) {
  return (
    <RollingStatusLine aria-live="polite" title={step}>
      <RollingSwap itemKey={step}>
        <Typo.Caption tone="secondary" truncate>{step}</Typo.Caption>
      </RollingSwap>
    </RollingStatusLine>
  );
}

export interface TaskGraphCardProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title" | "onClick" | "children"> {
  taskId: string;
  title: string;
  status: TaskGraphStatus;
  /** Localized status word shown in the Tag. */
  statusLabel: string;
  /** Assignee and model, e.g. "Worker 3 · GPT-6 Luna" (or "Not assigned"). */
  meta?: ReactNode;
  /** Elapsed or total time, tabular. */
  time?: ReactNode;
  /** Current step of a running task (rolls on change). */
  step?: string;
  selected?: boolean;
  /** True when activating opens a dialog (aria-haspopup). */
  opensDialog?: boolean;
  onActivate?: (taskId: string) => void;
  /** Accessible name; defaults to title, status, meta and time. */
  ariaLabel?: string;
}

/**
 * One task in a task graph: status glyph and title, meta line, status Tag with
 * time, and the live step while running. Running draws Card activity="running".
 * Read-only: activating only selects or opens; it never edits the task.
 */
export function TaskGraphCard({
  taskId, title, status, statusLabel, meta, time, step, selected = false, opensDialog = false, onActivate, ariaLabel, ...props
}: TaskGraphCardProps) {
  const label = ariaLabel ?? [title, statusLabel, typeof meta === "string" ? meta : null, typeof time === "string" ? time : null]
    .filter(Boolean).join(", ");
  return (
    <Card
      interactive
      padding="sm"
      selected={selected}
      activity={status === "running" ? "running" : undefined}
      aria-label={label}
      aria-pressed={selected}
      aria-haspopup={opensDialog ? "dialog" : undefined}
      data-task-id={taskId}
      data-task-status={status}
      data-test-class="task-graph-card"
      onClick={() => onActivate?.(taskId)}
      {...props}
    >
      <Stack gap="xs">
        <Stack align="row" gap="sm" cross="start">
          <IconSlot size="md" minHeight="line" tone="tertiary"><TaskGraphStatusIcon status={status} /></IconSlot>
          <Typo.Body lineClamp={2} grow minWidth="0" title={title}>{title}</Typo.Body>
        </Stack>
        {meta ? <Typo.Caption tone="tertiary" truncate>{meta}</Typo.Caption> : null}
        <Stack align="row" justify="between" cross="center" gap="sm">
          <Tag size="sm" tone={TONE[status]}>{statusLabel}</Tag>
          {time ? <Typo.Caption tone="tertiary" numeric="tabular" wrap="nowrap">{time}</Typo.Caption> : null}
        </Stack>
        {status === "running" && step ? <TaskGraphStepLine step={step} /> : null}
      </Stack>
    </Card>
  );
}
