import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { nextRunTime, runLabel, scheduleFrequency } from "@/automations/automationLabels";
import { useAutomation } from "@/automations/useAutomation";
import { timeLabel } from "@/conversation/sessions";
import { Button, icons, ListGroup, ListGroupItem, ListRow, Sheet, Text } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";

export default function Automation() {
  const params = useLocalSearchParams<{ id: string; title: string }>();
  const locale = useAppLocale(), app = getAppCopy(locale), copy = app.automations, M = useMobileCopy();
  const { automation: a, runs, error, busy, load, act, remove } = useAutomation(params.id);
  const [deleting, setDeleting] = useState(false);
  const now = new Date(), next = a ? nextRunTime(a, locale) : "";
  return <SettingsScreen title={a?.title ?? params.title}>
    {!a || error ? <ListGroup><LoadState error={error} onRetry={load} /></ListGroup> : <>
      <ListGroup>
        <ListRow title={copy.fields.targetChat} description={a.target_label} navigates
          onPress={() => router.push({ pathname: "/chat/[id]", params: { id: a.target_session_id, title: a.target_label } })} />
        <ListRow title={copy.frequency} description={scheduleFrequency(a, copy, locale)} />
        {next ? <ListRow title={M.automations.nextRun} description={next} /> : null}
        {a.last_run_at ? <ListRow title={M.automations.lastRun}
          description={`${runLabel({ state: a.last_run_state, safe_error_code: a.last_safe_error_code }, copy.runs)} · ${timeLabel(a.last_run_at, locale, now)}`} /> : null}
      </ListGroup>
      <ListGroup>
        <ListRow icon={icons.Play} accent title={copy.runNow} disabled={busy} onPress={() => void act("run")} />
        {a.state === "enabled" ? <ListRow icon={icons.Pause} accent title={copy.pause} onPress={() => void act("pause")} />
          : <ListRow icon={icons.Retry} accent title={copy.resume} onPress={() => void act("resume")} />}
      </ListGroup>
      <ListGroup><ListRow icon={icons.Delete} destructive title={app.common.delete} onPress={() => setDeleting(true)} /></ListGroup>
      <Sheet open={deleting} onClose={() => setDeleting(false)} title={app.common.delete}
        description={app.settings.deleteSchedule(a.title)} cancelLabel={M.settings.cancel}
        action={<Button variant="destructive" label={app.common.delete} onPress={async () => { if (await remove()) router.back(); }} />} />
      <ListGroup label={copy.fields.runs}>
        {runs.length ? runs.map(run => <ListRow key={run.id} title={runLabel(run, copy.runs)} meta={timeLabel(run.started_at, locale, now)}
          navigates={!!run.turn_id} onPress={run.turn_id ? () => router.push({ pathname: "/chat/[id]", params: { id: run.target_session_id, title: a.target_label } }) : undefined} />)
          : <ListGroupItem><Text variant="caption">{copy.runs.empty}</Text></ListGroupItem>}
      </ListGroup>
    </>}
  </SettingsScreen>;
}
