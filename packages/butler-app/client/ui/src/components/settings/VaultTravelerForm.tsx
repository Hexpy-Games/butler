import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Input, SegmentedControl, Stack, Typo } from "@/butler-ds";
import type { VaultTraveler } from "./vaultApi";

const DETAILS = ["name", "name_latin_surname", "name_latin_given", "nationality", "passport_expiry", "phone", "email"] as const;
const SECRETS = ["birth_date", "passport_number", "rrn"] as const;

/** Add or change traveler details. Secret fields start empty; on a change, empty keeps the saved value. */
export function VaultTravelerForm({ traveler, busy, onSave, onCancel }: {
  traveler?: VaultTraveler; busy: boolean; onCancel: () => void; onSave: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const copy = appCopy.settings.vault;
  const labels: Record<string, string> = { name: copy.travelerName, name_latin_surname: copy.latinSurname, name_latin_given: copy.latinGiven,
    nationality: copy.nationality, passport_expiry: copy.passportExpiry, phone: copy.phone, email: copy.email,
    birth_date: copy.birthDate, passport_number: copy.passportNumber, rrn: copy.rrn };
  const [nickname, setNickname] = useState(traveler?.nickname ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(DETAILS.map(key => [key, traveler?.details[key] ?? ""])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [gender, setGender] = useState(traveler?.details.gender ?? "");
  const ready = Boolean(nickname.trim() || values.name?.trim());
  async function save() {
    const input: Record<string, unknown> = { nickname: nickname.trim() || values.name?.trim(), gender, ...values };
    for (const key of SECRETS) if (secrets[key]?.trim()) input[key] = secrets[key]!.trim();
    if (await onSave(input)) setSecrets({});
  }
  const field = (key: string, secret: boolean) => (
    <Input key={key} aria-label={labels[key]} autoComplete="off" type={secret ? "password" : "text"}
      placeholder={secret && traveler?.extras.includes(key) ? `${labels[key]} · ${copy.keepSecret}` : labels[key]}
      value={(secret ? secrets[key] : values[key]) ?? ""}
      onChange={(event) => (secret ? setSecrets : setValues)(previous => ({ ...previous, [key]: event.target.value }))} />
  );
  return (
    <Stack gap="sm" data-test-class="vault-traveler-form">
      <Input aria-label={copy.nickname} placeholder={copy.nickname} autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} />
      {field("name", false)}
      <Stack as="span" align="row" gap="sm">{field("name_latin_surname", false)}{field("name_latin_given", false)}</Stack>
      {field("birth_date", true)}
      <Stack as="span" align="row" cross="center" gap="sm">
        <Typo.Caption tone="secondary">{copy.gender}</Typo.Caption>
        <SegmentedControl ariaLabel={copy.gender} value={gender}
          options={(["M", "F"] as const).map(value => ({ value, label: copy.genderOptions[value] }))} onValueChange={setGender} />
      </Stack>
      {field("nationality", false)}
      <Stack as="span" align="row" gap="sm">{field("passport_number", true)}{field("passport_expiry", false)}</Stack>
      {field("rrn", true)}
      <Stack as="span" align="row" gap="sm">{field("phone", false)}{field("email", false)}</Stack>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
        <Button size="sm" disabled={!ready || busy} data-test-class="vault-traveler-save" onClick={() => void save()}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
