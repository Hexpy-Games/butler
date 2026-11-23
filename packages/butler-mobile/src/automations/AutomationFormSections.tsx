import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useNavigationView } from "@/conversation/useNavigationView";
import { ListGroup, ListGroupItem, Text, TextField } from "@/ds";
import { useAppLocale } from "@/i18n";
import { accessModeOptions, SelectRow, SwitchRow, TimeRow } from "@/settings/rows";
import { modelLabel, runtimeModels, useModelCatalog } from "@/settings/useModelCatalog";
import {
  frequencyOf, intervalChoice, intervalPresets, withCustomMinutes, withFrequency, withInterval,
  type AutomationDraft, type AutomationFormField, type AutomationSaveError,
} from "./automationForm";
import { scheduleFrequency, scheduleWeekday } from "./automationLabels";

export function AutomationFormSections({ draft, set, error }: {
  draft: AutomationDraft;
  set(update: (current: AutomationDraft) => AutomationDraft, field: AutomationFormField): void;
  error: AutomationSaveError | null;
}) {
  const locale = useAppLocale(), app = getAppCopy(locale), copy = app.automations;
  const { view } = useNavigationView();
  const { catalog } = useModelCatalog();
  const general = app.interfacePanels.generalChat;
  const targets = [
    ...(view?.chats ?? []).map(chat => ({ value: chat.id, label: chat.id === "general" ? general : chat.title })),
    ...(view?.projects ?? []).flatMap(project => (project.sessions ?? [])
      .map(session => ({ value: session.id, label: `${project.display_name} / ${session.title}` }))),
  ];
  const models = [{ value: "default", label: app.settings.options.consolidationModelDefault },
    ...(catalog ? runtimeModels(catalog) : []).map(model => ({ value: model.model_ref, label: modelLabel(model, locale) }))];
  const model = models.some(option => option.value === draft.model) ? draft.model : "default";
  const frequency = frequencyOf(draft), schedule = draft.schedule;
  const frequencies = (["interval", "daily", "weekdays", "weekly"] as const).map(kind => ({ value: kind as string, label: copy[kind] }));
  if (draft.scheduleType === "once") frequencies.push({ value: "once", label: copy.once });
  return <>
    <ListGroup>
      <ListGroupItem><TextField label={copy.fields.title} placeholder={copy.placeholders.title}
        value={draft.title} onChangeText={title => set(d => ({ ...d, title }), "title")}
        error={error?.field === "title" ? error.message : undefined} /></ListGroupItem>
      <ListGroupItem><TextField label={copy.fields.prompt} placeholder={copy.placeholders.prompt} multiline
        value={draft.promptBody} onChangeText={promptBody => set(d => ({ ...d, promptBody }), "prompt")}
        error={error?.field === "prompt" ? error.message : undefined} /></ListGroupItem>
    </ListGroup>
    <ListGroup label={copy.fields.details}>
      <SelectRow title={copy.fields.targetChat} value={draft.targetSessionId}
        options={targets.length ? targets : [{ value: "general", label: general }]}
        onSelect={targetSessionId => set(d => ({ ...d, targetSessionId }), "form")} />
      <SelectRow title={app.composer.model} value={model} options={models}
        onSelect={value => set(d => ({ ...d, model: value === "default" ? "" : value }), "model")}
        onReselect={model === "default" ? () => set(d => ({ ...d, model: "" }), "model") : undefined} />
      {error?.field === "model" ? <ListGroupItem><Text tone="danger">{error.message}</Text></ListGroupItem> : null}
      <SelectRow title={app.composer.permission} value={draft.accessMode} options={accessModeOptions(app, "auto")}
        onSelect={accessMode => set(d => ({ ...d, accessMode }), "accessMode")} />
      {error?.field === "accessMode" || error?.field === "form"
        ? <ListGroupItem><Text tone="danger">{error.message}</Text></ListGroupItem> : null}
    </ListGroup>
    <ListGroup>
      <SelectRow title={copy.frequency} value={frequency} options={frequencies}
        onSelect={value => set(d => withFrequency(d, value), "interval")} />
      {schedule ? <>
        <TimeRow title={copy.time} value={schedule.time} onChange={time => set(d => ({ ...d, schedule: { ...schedule, time } }), "interval")} />
        {frequency === "weekly" ? <SelectRow title={copy.weekday} value={String(schedule.weekdays[0])}
          options={[1, 2, 3, 4, 5, 6, 7].map(day => ({ value: String(day), label: scheduleWeekday(day, locale) }))}
          onSelect={day => set(d => ({ ...d, schedule: { ...schedule, weekdays: [Number(day)] } }), "interval")} /> : null}
      </> : draft.scheduleType !== "once" ? <>
        <SelectRow title={copy.fields.interval} value={intervalChoice(draft)} options={[
          ...intervalPresets.map(seconds => ({ value: String(seconds), label: scheduleFrequency({
            schedule: null, schedule_type: "interval", interval_seconds: seconds,
          }, copy, locale) })), { value: "custom", label: app.interfacePanels.custom },
        ]} onSelect={value => set(d => withInterval(d, value), "interval")} />
        {draft.customInterval ? <ListGroupItem><TextField label={copy.fields.customMinutes} keyboardType="number-pad"
          value={draft.customMinutes} onChangeText={text => set(d => withCustomMinutes(d, text), "interval")}
          error={error?.field === "interval" ? error.message : undefined} /></ListGroupItem>
          : error?.field === "interval" ? <ListGroupItem><Text tone="danger">{error.message}</Text></ListGroupItem> : null}
      </> : null}
    </ListGroup>
    <ListGroup label={copy.browser.title}>
      <SwitchRow title={copy.browser.signin} value={draft.browserSignin}
        onChange={browserSignin => set(d => ({ ...d, browserSignin }), "form")} />
      <SwitchRow title={copy.browser.payment} value={draft.browserPayment}
        onChange={browserPayment => set(d => ({ ...d, browserPayment }), "form")} />
    </ListGroup>
  </>;
}
