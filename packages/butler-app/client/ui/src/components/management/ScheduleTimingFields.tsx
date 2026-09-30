import { appCopy } from "@/app/copy";
import { localSchedule, scheduleFrequency, scheduleWeekday } from "@/app/scheduleLabels";
import { Field, FieldError, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/butler-ds";
import { useAutomationStore } from "@/stores/automationStore";

export function ScheduleTimingFields() {
  const { schedule, scheduleType, intervalSeconds, setSchedule, setIntervalSeconds, saveError } = useAutomationStore();
  const copy = appCopy.automations;
  const frequency = schedule?.kind === "daily" ? "daily" : schedule?.weekdays.join(",") === "1,2,3,4,5" ? "weekdays" : schedule ? "weekly" : scheduleType;
  const interval = [600, 1800, 3600, 7200, 86400].includes(intervalSeconds) ? String(intervalSeconds) : "custom";
  const error = saveError?.field === "interval" ? saveError.message : undefined;
  return <>
    <Field>
      <FieldLabel>{copy.frequency}</FieldLabel>
      <Select value={frequency} onValueChange={(value) => {
        if (!value || value === "once") return;
        if (value === "interval") setSchedule(null);
        else {
          const next = localSchedule(value === "daily" ? "daily" : "weekly", value === "weekdays" ? [1, 2, 3, 4, 5] : value === "weekly" ? [1] : []);
          setSchedule({ ...next, time: schedule?.time ?? next.time, tz: schedule?.tz ?? next.tz });
        }
      }}>
        <SelectTrigger aria-invalid={error ? true : undefined}><SelectValue /></SelectTrigger>
        <SelectContent>
          {(["interval", "daily", "weekdays", "weekly"] as const).map((kind) => <SelectItem key={kind} value={kind}>{copy[kind]}</SelectItem>)}
          {scheduleType === "once" && <SelectItem value="once">{copy.once}</SelectItem>}
        </SelectContent>
      </Select>
      <FieldError>{error}</FieldError>
    </Field>
    {schedule ? <>
      <Field>
        <FieldLabel>{copy.time}</FieldLabel>
        <Input type="time" value={schedule.time} onChange={(event) => setSchedule({ ...schedule, time: event.target.value })} />
      </Field>
      {frequency === "weekly" && <Field>
        <FieldLabel>{copy.weekday}</FieldLabel>
        <Select value={String(schedule.weekdays[0])} onValueChange={(value) => setSchedule({ ...schedule, weekdays: [Number(value)] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{[1, 2, 3, 4, 5, 6, 7].map((day) => <SelectItem key={day} value={String(day)}>{scheduleWeekday(day)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>}
    </> : scheduleType !== "once" && <>
      <Field>
        <FieldLabel>{copy.fields.interval}</FieldLabel>
        <Select value={interval} onValueChange={(value) => setIntervalSeconds(value === "custom" ? 900 : Number(value))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {[600, 1800, 3600, 7200, 86400].map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{scheduleFrequency({ interval_seconds: seconds })}</SelectItem>)}
            <SelectItem value="custom">{appCopy.interfacePanels.custom}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {interval === "custom" && <Field>
        <FieldLabel>{copy.fields.customMinutes}</FieldLabel>
        <Input type="number" min="5" max="1440" value={Math.round(intervalSeconds / 60)} onChange={(event) => {
          const minutes = Number(event.target.value);
          if (Number.isFinite(minutes)) setIntervalSeconds(Math.max(5, Math.min(1440, minutes)) * 60);
        }} />
      </Field>}
    </>}
  </>;
}
