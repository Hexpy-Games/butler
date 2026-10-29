import { useId, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, NativeSelect, NativeSelectOption, Field, FieldLabel, Stack, Switch } from "@/butler-ds";
import { historyCommand } from "./historyApi";
export function HistoryClearDialog({ onClose }: { onClose: () => void }) {
  const copy = appCopy.browser.history;
  const onlyId = useId(), [range, setRange] = useState("hour"), [only, setOnly] = useState(false), [busy, setBusy] = useState(false);
  async function clear() {
    setBusy(true);
    try { await historyCommand("clear", { range, butlerOnly: only }); onClose(); }
    catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={on => { if (!on && !busy) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{copy.clear}</DialogTitle></DialogHeader>
    <Stack gap="md"><NativeSelect aria-label={copy.clear} value={range} onChange={event => setRange(event.target.value)}
      >{["hour", "today", "week", "all"].map(value => <NativeSelectOption key={value} value={value}>{copy[value as "hour" | "today" | "week" | "all"]}</NativeSelectOption>)}</NativeSelect>
      <Field><FieldLabel htmlFor={onlyId}>{copy.butlerOnly}</FieldLabel><Switch id={onlyId} checked={only} onCheckedChange={setOnly} /></Field>
    </Stack><DialogFooter><ButtonContainer size="sm"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{appCopy.browser.cancel}</Button>
      <Button size="sm" disabled={busy} onClick={() => void clear()}>{appCopy.browser.remove}</Button></ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
