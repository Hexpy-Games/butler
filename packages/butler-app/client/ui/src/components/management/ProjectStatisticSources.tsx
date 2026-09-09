import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ChevronRight, FileText, MessageSquare, NavRow, Stack, Typo } from "@/butler-ds";
import { useProjectStatistics } from "./projectStatisticsContext.ts";
import styles from "./ProjectStatisticsPanel.module.css";

export function ProjectStatisticSources({ sourceKeys }: { sourceKeys: string[] }) {
  const { data, openSource } = useProjectStatistics();
  const locale = useAppLocale();
  const [limit, setLimit] = useState(5);
  const keys = [...new Set(sourceKeys)];
  const copy = appCopy.projectStatistics;
  return <Stack gap="xs" className={styles.sources}>
    <Typo.Caption aria-live="polite">{copy.sources(keys.length)}</Typo.Caption>
    {keys.slice(0, limit).map((key) => {
      const source = data.sources[key];
      if (!source) return null;
      const date = new Date(source.at);
      const time = !source.source && Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { timeZone: data.timezone, month: "short", day: "numeric" }) : "";
      return <NavRow key={key} multiline icon={source.source ? <FileText /> : <MessageSquare />}
        label={<span className={styles.title}>{source.title}</span>} actions={<ChevronRight />}
        meta={<Typo.Caption>{[source.session?.title !== source.title ? source.session?.title : null, time,
          source.durationMs === undefined ? null : new Intl.NumberFormat(locale, { style: "unit", unit: "second", maximumFractionDigits: 0 }).format(source.durationMs / 1000)].filter(Boolean).join(" · ")}</Typo.Caption>}
        onClick={() => openSource(key)} />;
    })}
    {keys.length > limit && <Button variant="inline" onClick={() => setLimit((value) => value + 10)}>{appCopy.projectSignpost.loadMore}</Button>}
  </Stack>;
}
