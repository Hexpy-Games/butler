import { useState } from "react";
import { useCalendars } from "expo-localization";
import DateTimePicker from "@expo/ui/community/datetime-picker";
import { ListRow, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { dateToTime, timeMeta, timeToDate } from "./format";

export interface TimeRowProps { title: string; value: string; onChange(value: string): void; disabled?: boolean }

/** Android: the row opens the Material 3 time dialog; OK saves, Cancel closes. */
export function TimeRow({ title, value, onChange, disabled }: TimeRowProps) {
  const t = useTokens();
  const [calendar] = useCalendars();
  const [open, setOpen] = useState(false);
  return <>
    <ListRow title={title} disabled={disabled} meta={timeMeta(value, useAppLocale())} onPress={() => setOpen(true)} />
    {open ? <DateTimePicker value={timeToDate(value)} mode="time" is24Hour={calendar?.uses24hourClock ?? false}
      accentColor={t.color("--accent")} themeVariant={t.scheme}
      onValueChange={(_, date) => { setOpen(false); onChange(dateToTime(date)); }}
      onDismiss={() => setOpen(false)} /> : null}
  </>;
}
