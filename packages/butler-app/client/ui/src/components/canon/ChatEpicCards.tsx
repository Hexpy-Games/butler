import type { ReactNode } from "react";
import { Card, Grid, Skeleton, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { EpicCard } from "./EpicCard.tsx";
import { openCanonEpic } from "./canonNavigation.ts";
import { useChatCanon } from "./useChatCanon.ts";

/** Board cards read the same overview and retain the answer's id order. */
export function ChatEpicCards({ projectId, ids, render }: { projectId: string; ids: string[]; render?: (cards: ReactNode) => ReactNode }) {
  useAppLocale();
  const snapshot = useChatCanon(projectId);
  if (snapshot.state === "error") return null;
  const epics = snapshot.state === "ready" ? new Map([
    ...snapshot.canon.backlog, ...snapshot.canon.plans.flatMap(plan => plan.works),
  ].map(epic => [epic.id, epic])) : null;
  const cards = <Grid columns="auto-fill" cross="start" gap="sm" data-test-class="chat-epic-cards">
    {ids.map(id => {
      if (snapshot.state === "loading") return <Card key={id} padding="md"><Stack gap="sm"><Skeleton height="title" /><Skeleton lines={2} /></Stack></Card>;
      const epic = epics?.get(id);
      return epic ? <EpicCard key={id} epic={epic} showStatus selected={false} onSelect={epicId => openCanonEpic(projectId, epicId)} />
        : <Card key={id} padding="md"><Typo.Caption tone="secondary">{appCopy.canon.deletedTask}</Typo.Caption></Card>;
    })}
  </Grid>;
  return render ? render(cards) : cards;
}
