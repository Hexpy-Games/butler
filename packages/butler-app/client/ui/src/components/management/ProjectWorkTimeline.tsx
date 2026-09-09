import { useState } from "react";
import { Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import { Button, ChartContainer, ChartTooltip, ChartTooltipContent, Section, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { DashboardStatisticsView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectWorkTimeline({ data }: { data: DashboardStatisticsView }) {
  const locale = useAppLocale();
  const [limit, setLimit] = useState(8);
  const [keyboard, setKeyboard] = useState(false);
  const copy = appCopy.projectSignpost;
  if (data.timeline.status === "unavailable") return <Section title={copy.workChanges}><Typo.Body>{copy.unavailable}</Typo.Body></Section>;
  const events = data.timeline.events;
  const works = [...new Map(events.map((event) => [event.workId, event.title])).entries()];
  const visible = works.slice(0, limit);
  const labels: Record<string, string> = { created: copy.created, updated: copy.updated, completed: copy.recordedCompletion,
    reviewed: copy.reviewed, disposition: copy.disposition };
  const date = (at: number) => new Date(at).toLocaleDateString(locale, { timeZone: data.timezone, month: "numeric", day: "numeric" });
  return <Section title={copy.workChanges} description={copy.timelineHelp}>
    <Stack gap="md">
      {data.timeline.truncated && <Typo.Caption>{copy.timelineLimited}</Typo.Caption>}
      {visible.map(([workId, title]) => <Stack key={workId} gap="xs">
        <Typo.Body>{title}</Typo.Body>
        <ChartContainer className={styles.timelineRow} aria-label={title} config={{ event: { label: copy.workChanges, color: "var(--context-chart-1)" } }}
          initialDimension={{ width: 320, height: 64 }} onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)}>
          <ScatterChart accessibilityLayer margin={{ top: 4, right: 16, bottom: 0, left: 16 }}>
            <XAxis type="number" dataKey="at" domain={[Date.parse(data.days[0]!.start), Date.parse(data.observedAt)]}
              tickFormatter={date} tickCount={4} minTickGap={32} />
            <YAxis type="number" dataKey="row" domain={[-1, 1]} hide /><ZAxis range={[40, 40]} />
            <ChartTooltip trigger={keyboard ? "hover" : "click"} content={<ChartTooltipContent hideLabel formatter={(_value, _name, item) =>
              `${date(Number(item.payload?.at))} · ${String(item.payload?.label ?? "")}`} />} />
            <Scatter name="event" fill="var(--color-event)" isAnimationActive={false}
              data={events.filter((event) => event.workId === workId).map((event) => ({ at: Date.parse(event.at), row: 0, label: labels[event.action] ?? copy.updated }))} />
          </ScatterChart>
        </ChartContainer>
      </Stack>)}
      {!works.length && <Typo.Body>{copy.noHistory}</Typo.Body>}
      {works.length > limit && <Button variant="borderless" onClick={() => setLimit((value) => value + 8)}>{copy.loaded(limit, works.length)} · {copy.loadMore}</Button>}
    </Stack>
  </Section>;
}
