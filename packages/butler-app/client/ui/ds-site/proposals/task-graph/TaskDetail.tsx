import {
  Button, ButtonContainer, CircleAlert, Clickable, InspectorPanel, KeyValueRow, Notice, Stack, Tag, Typo,
  WorkActivityBlock, WorkerActivityRow,
} from "@/butler-ds";
import type { ProposalLocale, TaskGraphCopy } from "./copy";
import type { TaskNode } from "./fixture";
import type { GraphIndex } from "./layout";
import { STATUS_TONE, statusIcon } from "./TaskCard";

function rowPhase(node: TaskNode): string | undefined {
  if (node.status === "running") return node.phase;
  if (node.status === "completed") return "complete";
  if (node.status === "failed" || node.status === "cancelled") return node.status;
  return undefined;
}

export interface TaskDetailProps {
  node: TaskNode;
  index: GraphIndex;
  copy: TaskGraphCopy;
  locale: ProposalLocale;
  elapsed: number | null;
  onSelect: (id: string) => void;
}

/**
 * Selected task, read-only: the same WorkerActivityRow + WorkActivityBlock the Workers tab renders,
 * then facts. Links move the selection; nothing here edits the graph.
 */
export function TaskDetail({ node, index, copy, locale, elapsed, onSelect }: TaskDetailProps) {
  const running = node.status === "running";
  const links = (ids: string[]) => ids.length === 0
    ? <Typo.Caption tone="tertiary">{copy.detail.none}</Typo.Caption>
    : (
      <Stack gap="xs" cross="end">
        {ids.map((id) => (
          <Clickable key={id} variant="text" onClick={() => onSelect(id)}>
            <Typo.Caption tone="secondary">{index.byId.get(id)!.title[locale]}</Typo.Caption>
          </Clickable>
        ))}
      </Stack>
    );
  return (
    <Stack gap="none" data-test-class="task-graph-detail">
    <InspectorPanel
      title={node.title[locale]}
      action={<Tag size="sm" tone={STATUS_TONE[node.status]}>{copy.status[node.status]}</Tag>}
    >
      {node.assignee ? (
        <WorkerActivityRow
          id={`task-detail-${node.id}`}
          compact
          icon={statusIcon(node.status)}
          title={copy.assignee(node.assignee.ordinal)}
          meta={node.assignee.model}
          phase={rowPhase(node)}
          phaseRailLabel={copy.detail.status}
          details={node.steps.length > 0 ? (
            <Stack gap="xs">
              {node.steps.map((step, i) => (
                <WorkActivityBlock key={i} density="compact" title={step[locale]} running={running && i === node.steps.length - 1} />
              ))}
            </Stack>
          ) : null}
        />
      ) : null}
      {node.reason ? <Notice tone="error" icon={<CircleAlert size="md" />} message={node.reason[locale]} /> : null}
      {node.status === "blocked" ? <Notice tone="warning" icon={<CircleAlert size="md" />} message={copy.blockedByFailure} /> : null}
      <Stack gap="xs">
        {elapsed !== null ? <KeyValueRow label={copy.detail.elapsed} value={copy.elapsed(elapsed)} valueTextSize="caption" /> : null}
        <KeyValueRow label={copy.detail.after} value={links(index.preds.get(node.id)!)} detailAlign="start" />
        <KeyValueRow label={copy.detail.next} value={links(index.succs.get(node.id)!)} detailAlign="start" />
      </Stack>
      {node.assignee ? (
        <ButtonContainer size="sm">
          <Button size="sm" variant="outline" type="button">{copy.detail.viewActivity}</Button>
        </ButtonContainer>
      ) : null}
    </InspectorPanel>
    </Stack>
  );
}
