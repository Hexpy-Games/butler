import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  Button, ButtonContainer, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SettingsField, Tooltip,
} from "@/butler-ds";
import type { MailAccountInput } from "./connectionsApi";

export function MailAccountForm({ busy, onSave, onCancel }: {
  busy: boolean; onSave: (input: MailAccountInput) => Promise<boolean>; onCancel: () => void;
}) {
  const copy = appCopy.settings.connections;
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<string | null>(null);
  const [smtp, setSmtp] = useState<string | null>(null);
  const [mode, setMode] = useState("batch");
  const domain = address.split("@")[1] ?? "";
  const imapHost = imap ?? (domain ? `imap.${domain}` : "");
  const smtpHost = smtp ?? (domain ? `smtp.${domain}` : "");
  const ready = Boolean(address.trim() && password && imapHost.trim() && smtpHost.trim());
  async function submit() {
    try {
      await onSave({ address: address.trim(), password, imap_host: imapHost.trim(), smtp_host: smtpHost.trim(),
        handling: mode === "batch" ? { mode: "batch", interval_minutes: 10 } : { mode: "immediate" } });
    } finally { setPassword(""); }
  }
  return <>
    <SettingsField id="mail-address" settingId="mail-address" label={copy.address} control={
      <Input id="mail-address" aria-label={copy.address} type="email" value={address} onChange={event => setAddress(event.target.value)} />
    } />
    <SettingsField id="mail-password" settingId="mail-password" label={copy.password} control={
      <Input id="mail-password" aria-label={copy.password} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
    } />
    <SettingsField id="mail-imap" settingId="mail-imap" label={copy.incoming} control={
      <Input id="mail-imap" aria-label={copy.incoming} value={imapHost} onChange={event => setImap(event.target.value)} />
    } />
    <SettingsField id="mail-smtp" settingId="mail-smtp" label={copy.outgoing} control={
      <Input id="mail-smtp" aria-label={copy.outgoing} value={smtpHost} onChange={event => setSmtp(event.target.value)} />
    } />
    <SettingsField id="mail-handling" settingId="mail-handling" label={copy.handling} control={
      <Select value={mode} onValueChange={setMode}>
        <SelectTrigger id="mail-handling" aria-label={copy.handling}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="batch">{copy.everyTenMinutes}</SelectItem><SelectItem value="immediate">{copy.immediate}</SelectItem></SelectContent>
      </Select>
    } />
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
      <Tooltip label={ready ? copy.connect : copy.fillAll}>
        <Button size="sm" disabled={!ready || busy} onClick={() => void submit()}>{copy.connect}</Button>
      </Tooltip>
    </ButtonContainer>
  </>;
}
