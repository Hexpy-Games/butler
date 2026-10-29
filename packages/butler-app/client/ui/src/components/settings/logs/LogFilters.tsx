import { useEffect, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Field, FieldLabel, Inline, Input, NativeSelect, Stack, Switch } from "@/butler-ds";
import { LOG_PERIODS, LOG_SEVERITIES, type LogFilter, type LogPeriod } from "./logsApi";

// The agent filters by process (agent, app); MCP servers are a category.
const SOURCES = ["app", "agent"] as const;

/** Search, level, source, category, period and the live switch above the log list. */
export function LogFilters({ filter, categories, live, onChange, onLiveChange }: {
  filter: LogFilter;
  categories: readonly string[];
  live: boolean;
  onChange: (next: Partial<LogFilter>) => void;
  onLiveChange: (live: boolean) => void;
}) {
  const copy = appCopy.settings.logs;
  const liveId = useId();
  const [query, setQuery] = useState(filter.q);
  // One query per pause in typing, not per keystroke.
  useEffect(() => {
    if (query === filter.q) return;
    const timer = window.setTimeout(() => onChange({ q: query }), 300);
    return () => window.clearTimeout(timer);
  }, [filter.q, onChange, query]);
  return (
    <Stack gap="sm">
      <Input type="search" value={query} placeholder={copy.search} aria-label={copy.search}
        onChange={(event) => setQuery(event.currentTarget.value)} />
      <Inline gap="sm" cross="center">
        <NativeSelect aria-label={copy.filters.level} value={filter.level}
          onChange={(event) => onChange({ level: event.currentTarget.value })}>
          <option value="">{copy.allLevels}</option>
          {LOG_SEVERITIES.map((level) => <option key={level} value={level}>{copy.severity[level]}</option>)}
        </NativeSelect>
        <NativeSelect aria-label={copy.filters.source} value={filter.source}
          onChange={(event) => onChange({ source: event.currentTarget.value })}>
          <option value="all">{copy.allSources}</option>
          {SOURCES.map((source) => <option key={source} value={source}>{copy.sources[source]}</option>)}
        </NativeSelect>
        <NativeSelect aria-label={copy.filters.category} value={filter.category}
          onChange={(event) => onChange({ category: event.currentTarget.value })}>
          <option value="">{copy.allCategories}</option>
          {[...new Set([...categories, ...(filter.category ? [filter.category] : [])])].sort()
            .map((category) => <option key={category} value={category}>{category}</option>)}
        </NativeSelect>
        <NativeSelect aria-label={copy.filters.period} value={filter.period}
          onChange={(event) => onChange({ period: event.currentTarget.value as LogPeriod })}>
          {LOG_PERIODS.map((period) => <option key={period} value={period}>{copy.periods[period]}</option>)}
        </NativeSelect>
        <Field>
          <FieldLabel htmlFor={liveId}>{copy.live}</FieldLabel>
          <Switch id={liveId} checked={live} onCheckedChange={onLiveChange} />
        </Field>
      </Inline>
    </Stack>
  );
}
