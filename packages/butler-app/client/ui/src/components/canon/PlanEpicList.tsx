import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, EmptyLine, SortableCardList, Stack, Tooltip, Typo } from "@/butler-ds";
import type { EpicCard, EpicInput, CanonPlan } from "@/app/canonApi.ts";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
import { PlanEpicActions } from "./PlanEpicActions.tsx";
import { openEpicConversation } from "./canonNavigation.ts";
export function PlanEpicList({ projectId, rows, plans, backlog, busy, onWrite, onReorder, onCreate }: {
  projectId: string; rows: EpicCard[]; plans: CanonPlan[]; backlog: boolean; busy: boolean;
  onWrite: (epic: EpicCard, input: EpicInput, message: string) => void;
  onReorder: (ids: string[]) => void; onCreate: () => void;
}) {
  const copy = appCopy.canon;
  const items = rows.map((epic, index) => ({
    id: epic.id, label: epic.title,
    title: <Stack as="span" inline align="row" cross="center" gap="xs" minWidth="0">
      <Typo.Caption tone="secondary" numeric="tabular">{index + 1} ·</Typo.Caption>
      <CanonStatusGlyph status={epic.canon_status} />
      <Typo.Text truncate>{epic.title}</Typo.Text>
      <CanonAvatar person={epic.assignee} />
    </Stack>,
    description: epic.description.split(/\r?\n/u)[0] || copy.noDescription,
    actions: <PlanEpicActions onOpen={() => void openEpicConversation(projectId, epic)} epic={epic} plans={plans} busy={busy} onWrite={onWrite} />,
  }));
  return <SortableCardList data-test-class="canon-plan-epics" title={<Tooltip label={copy.sharedGrip}><Typo.Text>{copy.epicCount(rows.length)}</Typo.Text></Tooltip>}
      description={backlog ? copy.backlogOrderHelp : copy.sharedOrder} items={items} disabled={busy}
      onReorder={items => onReorder(items.map(item => item.id))}
      empty={<Stack gap="md"><EmptyLine message={copy.noEpics} /><ButtonContainer size="sm">
        <Button size="sm" onClick={onCreate}>{copy.newEpic}</Button></ButtonContainer></Stack>} />;
}
