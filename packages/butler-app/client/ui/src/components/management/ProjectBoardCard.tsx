import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, Card, MessageSquare, Spinner, Stack, Typo } from "@/butler-ds";
import type { DashboardBoardCard } from "../../../../shared/app-contracts.ts";

export function ProjectBoardCard({ card, running, onOpen, onOpenSession }: {
  card: DashboardBoardCard; running: boolean; onOpen: () => void; onOpenSession: () => void;
}) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  return <Card interactive aria-label={card.title} onClick={onOpen}>
    <Stack gap="md">
      <Typo.Body lineClamp={2} wrap="anywhere">{card.title}</Typo.Body>
      {(card.taskProgress || card.actionProgress) && <Typo.Caption>
        {[card.taskProgress && `${copy.tasks} ${card.taskProgress.done}/${card.taskProgress.total}`,
          card.actionProgress && `${appCopy.composer.plan} ${card.actionProgress.done}/${card.actionProgress.total}`].filter(Boolean).join(" · ")}
      </Typo.Caption>}
      {card.session && <Button variant="borderless" size="xs"
        onClick={(event) => { event.stopPropagation(); onOpenSession(); }}>
        {running ? <Spinner /> : <MessageSquare />}
        <Typo.Text truncate>{card.session.title}</Typo.Text>
      </Button>}
    </Stack>
  </Card>;
}
