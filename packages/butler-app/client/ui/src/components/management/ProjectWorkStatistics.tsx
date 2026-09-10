import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChevronRight, NavRow, Section, Stack, Tabs, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import { useProjectStatistics } from "./projectStatisticsContext.ts";
import { ProjectStatisticChart } from "./ProjectStatisticChart.tsx";
import { ProjectStatisticSources } from "./ProjectStatisticSources.tsx";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectWorkStatistics() {
  useAppLocale();
  const { data, openSource } = useProjectStatistics();
  const [kind, setKind] = useState<"work" | "task">("work");
  const [lane, setLane] = useState<string>();
  const copy = appCopy.projectStatistics;
  if (!data.work) return <Section title={copy.flow}><Typo.Caption>{copy.unavailable}</Typo.Caption></Section>;
  const cards = data.work.cards[kind];
  const lanes = ["planned", "active", "review", "blocked"];
  const counts = lanes.map((stage) => cards.filter((card) => card.lane === stage).length);
  const maximum = Math.max(1, ...counts);
  const remaining = cards.filter((card) => lanes.includes(card.lane));
  const old = [...remaining].sort((a, b) => Number(b.lane === "blocked") - Number(a.lane === "blocked") ||
    (b.ageDays ?? -1) - (a.ageDays ?? -1)).slice(0, 5);
  const unknown = cards.filter((card) => card.lane === "other").length;
  const controls = <Tabs value={kind} onValueChange={(value) => { setKind(value as "work" | "task"); setLane(undefined); }}>
      <TabsList><TabsTrigger value="work">Work</TabsTrigger><TabsTrigger value="task">Task</TabsTrigger></TabsList>
    </Tabs>;
  return <Stack gap="xl">
    <div className={styles.weightedPair}>
    <Stack gap="sm">
    {data.ledgerHistoryAvailable ? <ProjectStatisticChart key={kind} title={copy.flow} description={kind === "task" ? copy.taskCompletionUnavailable : copy.flowHelp} series={data.work[kind]} actions={controls} />
      : <Section title={copy.flow} actions={controls}><Typo.Caption>{copy.historyUnavailable}</Typo.Caption></Section>}
    {data.work.excluded > 0 && <Typo.Caption>{copy.excluded(data.work.excluded)}</Typo.Caption>}
    </Stack>
    <Section title={copy.remaining} description={copy.remainingHelp}>
      <Stack gap="sm" className={styles.surface}>
        {lanes.map((stage, index) => <Button key={stage} variant="borderless" className={styles.distribution} onClick={() => setLane(stage)}>
          <span>{copy.labels[stage]}</span>
          <span className={styles.track}><span className={styles.fill} style={{ width: `${counts[index]! / maximum * 100}%` }} /></span>
          <span>{counts[index]}</span><ChevronRight />
        </Button>)}
        {unknown > 0 && <Typo.Caption>{copy.labels.other} · {unknown}</Typo.Caption>}
        {lane && <ProjectStatisticSources key={`${kind}:${lane}`} sourceKeys={cards.filter((card) => card.lane === lane).map((card) => card.sourceKey)} />}
      </Stack>
    </Section>
    </div>
    <Section title={copy.aging} description={copy.agingHelp}>
      <div className={styles.agingCards}>
        {!old.length && <Typo.Caption>{appCopy.projectSignpost.noRemaining}</Typo.Caption>}
        {old.map((card) => <NavRow key={card.id} multiline label={<span className={styles.title}>{card.title}</span>}
          actions={<ChevronRight />} onClick={() => openSource(card.sourceKey)}
          meta={<Stack gap="xs"><Typo.Caption>{copy.labels[card.lane]} · {card.ageDays === null ? copy.labels.unknown : copy.age(card.ageDays)}</Typo.Caption>
            {card.ageDays !== null && <span className={styles.track}><span className={styles.fill} style={{ width: `${card.ageDays / Math.max(1, ...old.map((item) => item.ageDays ?? 0)) * 100}%` }} /></span>}
          </Stack>} />)}
      </div>
    </Section>
  </Stack>;
}
