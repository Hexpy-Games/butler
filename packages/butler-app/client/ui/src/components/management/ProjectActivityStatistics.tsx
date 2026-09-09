import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChevronRight, NavRow, Section, Stack, Typo } from "@/butler-ds";
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
  return <Stack gap="xl">
    <Section title={copy.calendar} description={copy.calendarHelp}>
      <Stack gap="md" className={styles.surface}>
        {!data.ledgerHistoryAvailable && <Typo.Caption>{copy.historyUnavailable}</Typo.Caption>}
        {!data.sessionHistoryAvailable && <Typo.Caption>{copy.sessionUnavailable}</Typo.Caption>}
        <div className={styles.calendar}>
          {Array.from({ length: 7 }, (_, index) => <Typo.Caption key={`weekday-${index}`} className={styles.weekday}>
            {new Date(2026, 0, 4 + index).toLocaleDateString(locale, { weekday: "short" })}
          </Typo.Caption>)}
          {Array.from({ length: start }, (_, index) => <span key={`blank-${index}`} />)}
          {data.activity.buckets.map((day) => {
            const kinds = data.activity.keys.filter((key) => day.values[key]!.length > 0);
            const description = data.activity.keys.map((key) => `${copy.labels[key]} ${day.values[key]!.length}`).join(" · ");
            return <Button key={day.label} variant="borderless" className={styles.day} data-active={kinds.length > 0}
              aria-pressed={selected === day.label} aria-label={`${dayLabel(day.label)} · ${description}`}
              title={`${dayLabel(day.label)} · ${description}`} onClick={() => setSelected(day.label)}>
              <span>{day.label.endsWith("-01") ? day.label.slice(5) : day.label.slice(8)}</span>
              <span className={styles.dots}>{kinds.map((key) => <span key={key} data-kind={key} />)}</span>
            </Button>;
          })}
        </div>
        <div className={styles.legend}>{data.activity.keys.map((key) => <Typo.Caption key={key}>
          <span className={styles.swatch} data-kind={key} />{copy.labels[key]}
        </Typo.Caption>)}</div>
        <Typo.Caption>{dayLabel(data.days[0]!.date)} — {dayLabel(data.days.at(-1)!.date)}</Typo.Caption>
        {bucket && <>
          <Typo.SectionTitle>{dayLabel(bucket.label)}</Typo.SectionTitle>
          <Typo.Caption>{data.activity.keys.map((key) => `${copy.labels[key]} ${bucket.values[key]!.length}`).join(" · ")}</Typo.Caption>
          <ProjectStatisticSources key={bucket.label} sourceKeys={Object.values(bucket.values).flat()} />
        </>}
      </Stack>
    </Section>
    <Section title={copy.focus} description={copy.focusHelp}>
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
  </Stack>;
}
