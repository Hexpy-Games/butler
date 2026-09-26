import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ActivityHeatmap, ActivityStrip, Button, ChevronRight, Grid, NavRow, Section, Stack, Typo, Box, ProgressMeter } from "@/butler-ds";
import { useProjectStatistics } from "./projectStatisticsContext.ts";
import { ProjectStatisticSources } from "./ProjectStatisticSources.tsx";

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
  return <Grid columns={{ base: "1", wide: "2" }} gap="xl">
    <Section title={copy.calendar}>
      <Box border="hairline" radius="control" paddingX="lg" paddingY="md"><Stack gap="md">
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
      </Stack></Box>
    </Section>
    <Section title={copy.focus}>
      <Box border="hairline" radius="control" paddingX="lg" paddingY="md"><Stack gap="sm">
        {!activity.length && <Typo.Caption>{data.ledgerHistoryAvailable ? copy.empty : copy.unavailable}</Typo.Caption>}
        {activity.slice(0, limit).map((item) => <NavRow key={item.sourceKey} multiline onClick={() => openSource(item.sourceKey)}
          label={<Typo.Text lineClamp={2} wrap="anywhere">{data.sources[item.sourceKey]?.title}</Typo.Text>} actions={<ChevronRight />}
          meta={<Stack gap="xs"><Typo.Caption>{copy.changes(item.changes)}</Typo.Caption>
            <ProgressMeter bare ariaLabel={copy.changes(item.changes)} value={Math.round(item.changes / Math.max(1, activity[0]!.changes) * 100)} />
            <ActivityStrip ariaLabel={item.dates.map(dayLabel).join(", ")}
              days={data.days.map((day) => ({ key: day.date, label: dayLabel(day.date), active: item.dates.includes(day.date) }))} />
          </Stack>} />)}
        {activity.length > limit && <Button variant="inline" onClick={() => setLimit((value) => value + 10)}>{appCopy.projectSignpost.loadMore}</Button>}
      </Stack></Box>
    </Section>
  </Grid>;
}
