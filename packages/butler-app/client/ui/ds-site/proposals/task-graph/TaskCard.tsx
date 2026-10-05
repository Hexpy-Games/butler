import { useEffect, useState, type ReactNode } from "react";
import {
  Card, Circle, CircleAlert, CircleX, Eye, ICON_SIZE, IconSlot, LoadingIndicator, Minus,
  RollingStatusLine, RollingSwap, Stack, Tag, Typo, type TagTone,
} from "@/butler-ds";
import type { ProposalLocale, TaskGraphCopy, TaskStatus } from "./copy";
import type { TaskNode } from "./fixture";

export const STATUS_TONE: Record<TaskStatus, TagTone> = {
  pending: "neutral", running: "accent", awaiting_review: "accent", completed: "neutral",
  failed: "danger", cancelled: "neutral", blocked: "warning", paused: "neutral",
};

/** One status glyph per state. Running and done share LoadingIndicator, so running -> done draws the check. */
export function statusIcon(status: TaskStatus): ReactNode {
  switch (status) {
    case "running": return <LoadingIndicator state="loading" size={ICON_SIZE.md} />;
    case "completed": return <LoadingIndicator state="done" size={ICON_SIZE.md} />;
    case "awaiting_review": return <Eye size="md" />;
    case "failed": return <Typo.Text tone="danger"><CircleAlert size="md" /></Typo.Text>;
    case "blocked": return <Typo.Text tone="warning"><CircleAlert size="md" /></Typo.Text>;
    case "cancelled": return <CircleX size="md" />;
    case "paused": return <Minus size="md" />;
    default: return <Circle size="md" />;
  }
}

/** Elapsed seconds: live for a running attempt, the recorded duration once it ended. */
export function elapsedSeconds(node: TaskNode, now: number, loadedAt: number): number | null {
  if (node.status === "running" && node.startedAgo !== undefined) return node.startedAgo + (now - loadedAt) / 1000;
  return node.took ?? null;
}

export function assigneeLine(node: TaskNode, copy: TaskGraphCopy): string {
  return node.assignee ? `${copy.assignee(node.assignee.ordinal)} · ${node.assignee.model}` : copy.unassigned;
}

/** Rolls the running worker's current step every few seconds (RollingSwap honors reduced motion). */
export function RunningStep({ steps, locale }: { steps: TaskNode["steps"]; locale: ProposalLocale }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (steps.length < 2) return undefined;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % steps.length), 3200);
    return () => window.clearInterval(timer);
  }, [steps.length]);
  const step = steps[index]?.[locale];
  if (!step) return null;
  return (
    <RollingStatusLine aria-live="polite" title={step}>
      <RollingSwap itemKey={`${index}`}>
        <Typo.Caption tone="secondary" truncate>{step}</Typo.Caption>
      </RollingSwap>
    </RollingStatusLine>
  );
}

export interface TaskCardProps {
  node: TaskNode;
  copy: TaskGraphCopy;
  locale: ProposalLocale;
  elapsed: number | null;
  selected: boolean;
  /** Click or Enter/Space on the card (select, and open the conversation in variant A). */
  onActivate: (id: string) => void;
}

/** A task card: title, status, worker and model, time. Read-only; selecting it shows the detail. */
export function TaskCard({ node, copy, locale, elapsed, selected, onActivate }: TaskCardProps) {
  const title = node.title[locale];
  const time = elapsed === null ? null : copy.elapsed(elapsed);
  const running = node.status === "running";
  const label = copy.cardLabel([title, copy.status[node.status], assigneeLine(node, copy), time].filter(Boolean) as string[]);
  return (
    <Card
      interactive
      padding="sm"
      selected={selected}
      aria-label={label}
      aria-pressed={selected}
      data-task-id={node.id}
      data-task-status={node.status}
      data-test-class="task-graph-card"
      aria-haspopup={node.assignee ? "dialog" : undefined}
      onClick={() => onActivate(node.id)}
    >
      <Stack gap="xs">
        <Stack align="row" gap="sm" cross="start">
          <IconSlot size="md" minHeight="line" tone="tertiary">{statusIcon(node.status)}</IconSlot>
          <Typo.Body lineClamp={2} grow minWidth="0" title={title}>{title}</Typo.Body>
        </Stack>
        <Typo.Caption tone="tertiary" truncate>{assigneeLine(node, copy)}</Typo.Caption>
        <Stack align="row" justify="between" cross="center" gap="sm">
          <Tag size="sm" tone={STATUS_TONE[node.status]}>{copy.status[node.status]}</Tag>
          {time ? <Typo.Caption tone="tertiary" numeric="tabular" wrap="nowrap">{time}</Typo.Caption> : null}
        </Stack>
        {running ? <RunningStep steps={node.steps} locale={locale} /> : null}
      </Stack>
    </Card>
  );
}
