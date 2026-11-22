import { useState } from "react";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, environment, frame, tint } from "@expo/ui/swift-ui/modifiers";
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
      <Host matchContents={{ vertical: true }} ignoreSafeArea="all">
        <DatePicker selection={draft} displayedComponents={["hourAndMinute"]} onDateChange={setDraft}
          modifiers={[datePickerStyle("wheel"), tint(t.color("--accent")), environment("colorScheme", t.scheme),
            frame({ maxWidth: Infinity })]} />
      </Host>
    </Sheet>
  </>;
}
