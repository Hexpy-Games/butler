import { useState } from "react";
import DateTimePicker from "@expo/ui/community/datetime-picker";
import { Button, ListRow, Sheet, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { dateToTime, timeMeta, timeToDate } from "./format";

export interface TimeRowProps { title: string; value: string; onChange(value: string): void; disabled?: boolean }

/** iOS: the row opens a sheet with the system time wheel; 완료 saves. */
export function TimeRow({ title, value, onChange, disabled }: TimeRowProps) {
  const M = useMobileCopy();
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => timeToDate(value));
  return <>
    <ListRow title={title} disabled={disabled} meta={timeMeta(value, useAppLocale())}
      onPress={() => { setDraft(timeToDate(value)); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={title} cancelLabel={M.settings.cancel}
      action={<Button label={M.settings.done} onPress={() => { setOpen(false); onChange(dateToTime(draft)); }} />}>
      <DateTimePicker value={draft} mode="time" display="spinner" accentColor={t.color("--accent")}
        themeVariant={t.scheme} onValueChange={(_, date) => setDraft(date)} />
    </Sheet>
  </>;
}
