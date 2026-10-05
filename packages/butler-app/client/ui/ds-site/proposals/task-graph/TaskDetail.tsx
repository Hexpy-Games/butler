import {
  Button, ButtonContainer, CircleAlert, Clickable, DocumentTile, FileText, InspectorPanel, KeyValueRow, MessageSquare,
  Notice, Stack, Tag, Typo,
} from "@/butler-ds";
import type { ProposalLocale, TaskGraphCopy } from "./copy";
import type { TaskNode } from "./fixture";
import type { GraphIndex } from "./layout";
import { RunningStep, STATUS_TONE } from "./TaskCard";

export interface TaskDetailProps {
  node: TaskNode;
  index: GraphIndex;
  copy: TaskGraphCopy;
  locale: ProposalLocale;
  elapsed: number | null;
  onSelect: (id: string) => void;
  onOpenConversation?: () => void;
  onOpenDocument: () => void;
}

/**
 * Selected task, read-only, from DS blocks only: facts (KeyValueRow), the task document
 * (DocumentTile -> the existing project document dialog) and the conversation button
 * (-> the existing session dialog). Links move the selection; nothing edits the graph.
 */
export function TaskDetail({ node, index, copy, locale, elapsed, onSelect, onOpenConversation, onOpenDocument }: TaskDetailProps) {
  const d = copy.detail;
  const links = (ids: string[]) => ids.length === 0
    ? <Typo.Caption tone="tertiary">{d.none}</Typo.Caption>
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
      <InspectorPanel title={node.title[locale]} action={<Tag size="sm" tone={STATUS_TONE[node.status]}>{copy.status[node.status]}</Tag>}>
        {node.reason ? <Notice tone="error" icon={<CircleAlert size="md" />} message={node.reason[locale]} /> : null}
        {node.status === "blocked" ? <Notice tone="warning" icon={<CircleAlert size="md" />} message={copy.blockedByFailure} /> : null}
        <Stack gap="xs">
          <KeyValueRow label={d.assignee} value={node.assignee ? copy.assignee(node.assignee.ordinal) : d.noSession} valueTextSize="caption" />
          {node.assignee ? <KeyValueRow label={d.model} value={node.assignee.model} valueTextSize="caption" /> : null}
          {elapsed !== null ? <KeyValueRow label={d.elapsed} value={copy.elapsed(elapsed)} valueTextSize="caption" /> : null}
          {node.status === "running" ? <KeyValueRow label={d.step} value={<RunningStep steps={node.steps} locale={locale} />} valueTextSize="caption" /> : null}
          <KeyValueRow label={d.after} value={links(index.preds.get(node.id)!)} detailAlign="start" />
          <KeyValueRow label={d.next} value={links(index.succs.get(node.id)!)} detailAlign="start" />
        </Stack>
        <DocumentTile
          icon={<FileText size="md" />}
          title={d.document}
          meta={`TASK-${node.id.toUpperCase()} · ${copy.status[node.status]}`}
          actionLabel={d.openDocument}
          ariaLabel={`${d.document}: ${node.title[locale]}`}
          clickTarget="tile"
          onOpen={onOpenDocument}
        />
        {onOpenConversation ? (
          <ButtonContainer size="sm">
            <Button size="sm" variant="outline" type="button" aria-haspopup="dialog" onClick={onOpenConversation}>
              <MessageSquare size="sm" />{d.conversation}
            </Button>
          </ButtonContainer>
        ) : null}
      </InspectorPanel>
    </Stack>
  );
}
