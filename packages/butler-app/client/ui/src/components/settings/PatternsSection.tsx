import { Fragment } from "react";
import { appCopy } from "@/app/copy.ts";
import { EmptyLine, ExpandableText, IconButton, ScrollArea, Separator, SettingsSection, SkeletonRows, Stack, Button, Spinner, Trash2, Typo } from "@/butler-ds";
import { patternMeta, usePatterns } from "./hooks/usePatterns";
import { ProactiveFields } from "./ProactiveFields";

export function PatternsSection({ consentOn }: { consentOn?: boolean }) {
  const patterns = usePatterns();
  const copy = appCopy.settings;
  return <SettingsSection id="noticed-patterns" kind="form" title={copy.pageSections.noticedPatterns} description={copy.pageSectionDescriptions.noticedPatterns}>
    {consentOn === false && <Typo.Caption tone="secondary">{copy.memory.profileBuildingOff}</Typo.Caption>}
    {patterns.state === "loading" ? <SkeletonRows rows={2} /> : patterns.state === "error" ?
      <Stack gap="sm"><Typo.Caption tone="secondary" role="alert">{copy.sectionState.error}</Typo.Caption>
        <Button variant="outline" size="sm" onClick={patterns.reload}>{copy.sectionState.retry}</Button></Stack> : patterns.state === "empty" ?
        <EmptyLine message={copy.memory.patternsEmpty} /> :
        <ScrollArea maxHeight="sm" dataTestClass="pattern-list"><Stack gap="md">
          {patterns.rows.map((item, index) => <Fragment key={item.id}>
            {index > 0 && <Separator space="none" />}
            <Stack id={`pattern-${item.id}`} data-test-class="pattern-row" align="row" cross="start" gap="md">
              <Stack.Item grow minWidth="0"><ExpandableText id={`pattern-text-${item.id}`} collapsedLines={1} meta={patternMeta(item)}>{item.title}</ExpandableText></Stack.Item>
              <IconButton label={patterns.deleting ? `${appCopy.common.delete} · ${copy.memory.deleting}` : appCopy.common.delete}
                disabled={Boolean(patterns.deleting)} aria-busy={patterns.deleting === item.id || undefined} aria-describedby={`pattern-text-${item.id}`}
                onClick={() => { void patterns.remove(item); }}>
                {patterns.deleting === item.id ? <Spinner size={14} /> : <Trash2 size="md" />}
              </IconButton>
            </Stack>
          </Fragment>)}
        </Stack></ScrollArea>}
    <ProactiveFields />
  </SettingsSection>;
}
