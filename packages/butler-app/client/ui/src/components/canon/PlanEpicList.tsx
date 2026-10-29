import { appCopy } from "@/app/copy.ts";
import { ADAPTIVE_MEDIA, Box, EmptyLine, Notebook, SortableCardList, Stack, Tooltip, Typo, useMediaMatch } from "@/butler-ds";
import type { EpicCard, EpicInput, CanonPlan } from "@/app/canonApi.ts";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonEpicStatus } from "./CanonEpicStatus.tsx";
import { PlanEpicActions } from "./PlanEpicActions.tsx";
import { openEpicConversation } from "./canonNavigation.ts";
export function PlanEpicList({ projectId, rows, plans, backlog, busy, onWrite, onReorder }: {
  projectId: string; rows: EpicCard[]; plans: CanonPlan[]; backlog: boolean; busy: boolean;
  onWrite: (epic: EpicCard, input: EpicInput, message: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const copy = appCopy.canon;
  const compact = useMediaMatch(ADAPTIVE_MEDIA.compact);
  const items = rows.map((epic, index) => ({
    id: epic.id, label: epic.title,
    title: <Stack as="span" align="row" cross="center" gap="sm" minWidth="0">
      <Typo.Caption shrink={false} tone="secondary" numeric="tabular">{index + 1} ·</Typo.Caption>
      <Stack as="span" shrink={false}><CanonEpicStatus epic={epic} /></Stack>
      <Typo.Text data-test-class="canon-epic-title" truncate shrink minWidth="0">{epic.title}</Typo.Text>
      <Stack as="span" shrink={false}><CanonAvatar agent={epic.agent} person={epic.assignee} /></Stack>
    </Stack>,
    description: <Stack as="span" gap="sm"><Typo.Caption truncate>{epic.description.split(/\r?\n/u)[0] || copy.noDescription}</Typo.Caption>
      {compact && <Box as="span" padding="xs"><PlanEpicActions onOpen={() => void openEpicConversation(projectId, epic)} epic={epic} plans={plans} busy={busy} onWrite={onWrite} /></Box>}
    </Stack>,
    actions: compact ? undefined : <PlanEpicActions onOpen={() => void openEpicConversation(projectId, epic)} epic={epic} plans={plans} busy={busy} onWrite={onWrite} />,
  }));
  return <SortableCardList data-test-class="canon-plan-epics" title={<Tooltip label={copy.sharedGrip}><Typo.Text>{copy.epicCount(rows.length)}</Typo.Text></Tooltip>}
      description={backlog ? copy.backlogOrderHelp : copy.sharedOrder} items={items} disabled={busy}
      onReorder={items => onReorder(items.map(item => item.id))}
      empty={<EmptyLine icon={<Notebook />} message={copy.noEpics} />} />;
}
