import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ActivityHeatmap, Button, ChevronRight, NavRow, Section, Stack, Typo } from "@/butler-ds";
import { useProjectStatistics } from "./projectStatisticsContext.ts";
import { ProjectStatisticSources } from "./ProjectStatisticSources.tsx";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectActivityStatistics() {
  const locale = useAppLocale();
  const { data, openSource } = useProjectStatistics();
  const [selected, setSelected] = useState<string>();
  const [limit, setLimit] = useState(5);
  const copy = appCopy.projectStatistics;
  const dayLabel = (label: string) => new Date(`${label}T12:00:00`).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const bucket = data.activity.buckets.find((day) => day.label === selected);
  const start = new Date(`${data.days[0]!.date}T12:00:00`).getDay();
  const activity = data.work?.activity ?? [];
  return <div className={styles.pair}>
    <Section title={copy.calendar}>
      <Stack gap="md" className={styles.surface}>
        {!data.ledgerHistoryAvailable && <Typo.Caption>{copy.historyUnavailable}</Typo.Caption>}
        {!data.sessionHistoryAvailable && <Typo.Caption>{copy.sessionUnavailable}</Typo.Caption>}
        <ActivityHeatmap ariaLabel={copy.calendar} startWeekday={start}
          weekdayLabels={Array.from({ length: 7 }, (_, index) =>
            new Date(2026, 0, 4 + index).toLocaleDateString(locale, { weekday: "short" }))}
          selectedId={selected} onSelect={setSelected}
          days={data.activity.buckets.map((day) => ({
            id: day.label,
            monthLabel: new Date(`${day.label}T12:00:00`).toLocaleDateString(locale, { month: "short" }),
            countLabel: copy.activeItems(Object.values(day.values).reduce((count, keys) => count + keys.length, 0)),
            label: `${dayLabel(day.label)} · ${!data.ledgerHistoryAvailable && !data.sessionHistoryAvailable ? copy.unavailable
              : data.activity.keys.map((key) => `${copy.labels[key]} ${day.values[key]!.length}`).join(" · ")}`,
            count: !data.ledgerHistoryAvailable && !data.sessionHistoryAvailable ? null
              : Object.values(day.values).reduce((count, keys) => count + keys.length, 0),
          }))} />
        <Typo.Caption>{dayLabel(data.days[0]!.date)} — {dayLabel(data.days.at(-1)!.date)}</Typo.Caption>
        {bucket && <>
          <Typo.SectionTitle>{dayLabel(bucket.label)}</Typo.SectionTitle>
          <Typo.Caption>{data.activity.keys.map((key) => `${copy.labels[key]} ${bucket.values[key]!.length}`).join(" · ")}</Typo.Caption>
          <ProjectStatisticSources key={bucket.label} sourceKeys={Object.values(bucket.values).flat()} />
        </>}
      </Stack>
    </Section>
    <Section title={copy.focus}>
      <Stack gap="sm" className={styles.surface}>
        {!activity.length && <Typo.Caption>{data.ledgerHistoryAvailable ? copy.empty : copy.unavailable}</Typo.Caption>}
        {activity.slice(0, limit).map((item) => <NavRow key={item.sourceKey} multiline onClick={() => openSource(item.sourceKey)}
          label={<span className={styles.title}>{data.sources[item.sourceKey]?.title}</span>} actions={<ChevronRight />}
          meta={<Stack gap="xs"><Typo.Caption>{copy.changes(item.changes)}</Typo.Caption>
            <span className={styles.track}><span className={styles.fill} style={{ width: `${item.changes / Math.max(1, activity[0]!.changes) * 100}%` }} /></span>
            <span className={styles.activityDates} aria-label={item.dates.map(dayLabel).join(", ")}>
              {data.days.map((day) => <span key={day.date} data-active={item.dates.includes(day.date)} title={dayLabel(day.date)} />)}
            </span>
          </Stack>} />)}
        {activity.length > limit && <Button variant="inline" onClick={() => setLimit((value) => value + 10)}>{appCopy.projectSignpost.loadMore}</Button>}
      </Stack>
    </Section>
  </div>;
}
