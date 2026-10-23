import { appCopy } from "@/app/copy.ts";
import { Box, Button, ButtonContainer, EmptyLine, SortableCardList, Stack, Tooltip, Typo } from "@/butler-ds";
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
    leading: <Typo.Caption numeric="tabular">{index + 1}</Typo.Caption>,
    title: <Stack as="span" inline align="row" cross="center" gap="xs" minWidth="0">
      <CanonStatusGlyph status={epic.canon_status} />
      <Box as="span" padding="sm"><Button size="sm" variant="link" onClick={() => void openEpicConversation(projectId, epic)}>{epic.title}</Button></Box>
      <CanonAvatar person={epic.assignee} />
    </Stack>,
    description: epic.description.split(/\r?\n/u)[0] || copy.noDescription,
    actions: <PlanEpicActions epic={epic} plans={plans} busy={busy} onWrite={onWrite} />,
  }));
  return <Tooltip label={copy.sharedGrip}>
    <SortableCardList data-test-class="canon-plan-epics" title={copy.epicCount(rows.length)}
      description={backlog ? copy.backlogOrderHelp : copy.sharedOrder} items={items} disabled={busy}
      onReorder={items => onReorder(items.map(item => item.id))}
      empty={<Stack gap="md"><EmptyLine message={copy.noEpics} /><ButtonContainer size="sm">
        <Button size="sm" onClick={onCreate}>{copy.newEpic}</Button></ButtonContainer></Stack>} />
  </Tooltip>;
}
