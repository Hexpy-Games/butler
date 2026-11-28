import { useState } from "react";
import { Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { nextRunTime, runLabel, scheduleFrequency } from "@/automations/automationLabels";
import { useAutomationModelOptions } from "@/automations/AutomationFormSections";
import { RunRow } from "@/automations/RunRow";
import { useAutomation } from "@/automations/useAutomation";
import { timeLabel } from "@/conversation/sessions";
import { Button, IconButton, icons, ListGroup, ListGroupItem, ListRow, Sheet, Text } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import { accessModeOptions } from "@/settings/rows";

export default function Automation() {
  const params = useLocalSearchParams<{ id: string; title: string }>();
  const locale = useAppLocale(), app = getAppCopy(locale), copy = app.automations, M = useMobileCopy();
  const { automation: a, runs, moreRuns, error, busy, deleting: deletePending, load, act, remove } = useAutomation(params.id);
  const models = useAutomationModelOptions();
  const [deleting, setDeleting] = useState(false);
  const now = new Date(), next = a ? nextRunTime(a, locale) : "";
  const target = a?.target_label ?? copy.deletedChat;
  const edit = () => router.push({ pathname: "/automations/edit", params: { id: params.id } });
  return <SettingsScreen title={a?.title ?? params.title} options={a && !error ? Platform.OS === "ios" ? {
    unstable_headerRightItems: () => [{ type: "button", label: M.automations.edit,
      icon: { type: "sfSymbol", name: "pencil" }, onPress: edit }],
  } : { headerRight: () => <IconButton icon={icons.Edit} variant="ghost" label={M.automations.edit} onPress={edit} /> } : undefined}>
    {!a || error ? <ListGroup><LoadState error={error} onRetry={load} /></ListGroup> : <>
      <ListGroup label={copy.fields.prompt}>
        <ListGroupItem><Text selectable>{a.prompt_body}</Text></ListGroupItem>
      </ListGroup>
      <ListGroup label={copy.fields.details}>
        <ListRow title={copy.fields.targetChat} description={target} navigates
          onPress={() => router.push({ pathname: "/chat/[id]", params: { id: a.target_session_id, title: target } })} />
        <ListRow title={app.composer.model}
          description={models.find(o => o.value === (a.model || "default"))?.label ?? models[0].label} />
        <ListRow title={app.composer.permission}
          description={accessModeOptions(app, "auto").find(o => o.value === a.access_mode)?.label ?? a.access_mode} />
      </ListGroup>
      <ListGroup>
        <ListRow title={copy.frequency} description={scheduleFrequency(a, copy, locale)} />
        {next ? <ListRow title={M.automations.nextRun} description={next} /> : null}
        {a.last_run_at ? <ListRow title={M.automations.lastRun}
          description={`${runLabel({ state: a.last_run_state, safe_error_code: a.last_safe_error_code }, copy.runs)} · ${timeLabel(a.last_run_at, locale, now)}`} /> : null}
      </ListGroup>
      {a.browser_signin || a.browser_payment ? <ListGroup label={copy.browser.title}>
        {a.browser_signin ? <ListRow title={copy.browser.signin} /> : null}
        {a.browser_payment ? <ListRow title={copy.browser.payment} /> : null}
      </ListGroup> : null}
      <ListGroup>
        <ListRow icon={icons.Play} accent title={copy.runNow} disabled={busy} onPress={() => void act("run")} />
        {a.state === "enabled" ? <ListRow icon={icons.Pause} accent title={copy.pause} onPress={() => void act("pause")} />
          : <ListRow icon={icons.Retry} accent title={copy.resume} onPress={() => void act("resume")} />}
      </ListGroup>
      <ListGroup><ListRow icon={icons.Delete} destructive title={app.common.delete} onPress={() => setDeleting(true)} /></ListGroup>
      <ListGroup label={copy.fields.runs}>
        {runs.length ? runs.map(run => <RunRow key={run.id} run={run} target={target} now={now} />)
          : <ListGroupItem><Text variant="caption">{copy.runs.empty}</Text></ListGroupItem>}
        {moreRuns ? <ListRow title={M.automations.allRuns} navigates
          onPress={() => router.push({ pathname: "/automations/runs", params: { id: a.id, title: a.title, target } })} /> : null}
      </ListGroup>
      <Sheet open={deleting} onClose={() => setDeleting(false)} title={app.common.delete}
        description={app.settings.deleteSchedule(a.title)} cancelLabel={M.settings.cancel}
        action={<Button variant="destructive" label={app.common.delete} disabled={deletePending} onPress={async () => { if (await remove()) router.back(); }} />} />
    </>}
  </SettingsScreen>;
}
