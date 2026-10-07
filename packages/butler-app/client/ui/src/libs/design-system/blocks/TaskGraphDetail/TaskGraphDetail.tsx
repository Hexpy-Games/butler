import type { ReactNode } from "react";
import type { TaskGraphStatus } from "../../lib/taskGraphLayout";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Clickable } from "../../components/Clickable";
import { CircleAlert, FileText, MessageSquare } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { DocumentTile } from "../DocumentTile";
import { InspectorPanel } from "../InspectorPanel";
import { KeyValueRow } from "../KeyValueRow";
import { Notice } from "../Notice";
import { taskGraphStatusTone } from "../TaskGraphCard";

export interface TaskGraphDetailFact {
  id: string;
  label: string;
  value: ReactNode;
}

export interface TaskGraphDetailRelation {
  id: string;
  /** "After" / "Next". */
  label: string;
  tasks: Array<{ id: string; title: string }>;
  /** Shown when `tasks` is empty ("None"). */
  emptyLabel: string;
}

export interface TaskGraphDetailProps {
  title: string;
  status: TaskGraphStatus;
  statusLabel: string;
  /** Failure reason (error) or blocked explanation (warning); short, no codes. */
  notice?: { tone: "error" | "warning"; message: string };
  /** Assignee, model, elapsed time, current step (TaskGraphStepLine)… in order. */
  facts: TaskGraphDetailFact[];
  /** Prerequisite links; selecting one only moves the selection. */
  relations?: TaskGraphDetailRelation[];
  onSelectTask?: (taskId: string) => void;
  /** The task document tile; opening it shows the caller's document dialog. */
  document?: { title: string; meta?: string; ariaLabel?: string; actionLabel?: string; onOpen: () => void };
  /** Opens the worker's conversation (the caller's session dialog). */
  conversation?: { label: string; onOpen: () => void };
}

/**
 * The selected task, read-only: status, facts, prerequisite links, the task
 * document and the conversation action. Data-agnostic; all copy and actions
 * come in through props.
 */
export function TaskGraphDetail({ title, status, statusLabel, notice, facts, relations = [], onSelectTask, document, conversation }: TaskGraphDetailProps) {
  return (
    <Stack gap="none" data-test-class="task-graph-detail">
      <InspectorPanel title={title} action={<Tag size="sm" tone={taskGraphStatusTone(status)}>{statusLabel}</Tag>}>
        {notice ? <Notice tone={notice.tone} icon={<CircleAlert size="md" />} message={notice.message} /> : null}
        <Stack gap="xs">
          {facts.map((fact) => <KeyValueRow key={fact.id} label={fact.label} value={fact.value} valueTextSize="caption" />)}
          {relations.map((relation) => (
            <KeyValueRow key={relation.id} label={relation.label} detailAlign="start" value={relation.tasks.length === 0
              ? <Typo.Caption tone="tertiary">{relation.emptyLabel}</Typo.Caption>
              : (
                <Stack gap="xs" cross="end">
                  {relation.tasks.map((task) => (
                    <Clickable key={task.id} variant="text" onClick={() => onSelectTask?.(task.id)}>
                      <Typo.Caption tone="secondary">{task.title}</Typo.Caption>
                    </Clickable>
                  ))}
                </Stack>
              )} />
          ))}
        </Stack>
        {document ? (
          <DocumentTile icon={<FileText size="md" />} title={document.title} meta={document.meta} ariaLabel={document.ariaLabel}
            actionLabel={document.actionLabel} clickTarget="tile" onOpen={document.onOpen} />
        ) : null}
        {conversation ? (
          <ButtonContainer size="sm">
            <Button size="sm" variant="outline" type="button" aria-haspopup="dialog" onClick={conversation.onOpen}>
              <MessageSquare size="sm" />{conversation.label}
            </Button>
          </ButtonContainer>
        ) : null}
      </InspectorPanel>
    </Stack>
  );
}
