import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, Clickable, LoaderCircle, MessageSquare, Stack, Typo } from "@/butler-ds";
import type { DashboardBoardCard } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import styles from "./ProjectWorkBoard.module.css";

export function ProjectBoardCard({ card, running, onOpen, onOpenSession }: {
  card: DashboardBoardCard; running: boolean; onOpen: () => void; onOpenSession: () => void;
}) {
  useAppLocale();
  const copy = appCopy.projectSignpost;
  return <Clickable className={styles.card} aria-label={card.title} onClick={onOpen}>
    <Stack gap="md">
      <Typo.Body className={styles.cardTitle}>{card.title}</Typo.Body>
      {(card.taskProgress || card.actionProgress) && <Typo.Caption>
        {[card.taskProgress && `${copy.tasks} ${card.taskProgress.done}/${card.taskProgress.total}`,
          card.actionProgress && `${appCopy.composer.plan} ${card.actionProgress.done}/${card.actionProgress.total}`].filter(Boolean).join(" · ")}
      </Typo.Caption>}
      {card.session && <Button variant="borderless" size="xs" className={styles.session}
        onClick={(event) => { event.stopPropagation(); onOpenSession(); }}>
        {running ? <LoaderCircle className={styles.spinner} /> : <MessageSquare />}
        <span className={styles.sessionTitle}>{card.session.title}</span>
      </Button>}
    </Stack>
  </Clickable>;
}
