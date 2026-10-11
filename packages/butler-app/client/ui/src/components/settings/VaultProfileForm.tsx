import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Collapsible, Input, SegmentedControl, Stack, Typo } from "@/butler-ds";
import type { VaultProfile } from "./vaultApi";

const DETAILS = ["name", "family_name", "given_name", "name_latin", "name_latin_surname", "name_latin_given", "organization",
  "country", "postal_code", "region", "city", "address_line1", "address_line2", "nationality", "issuing_country", "passport_expiry", "phone", "email"] as const;
const SECRETS = ["birth_date", "passport_number"] as const;

/** Secret fields start empty; on a change, empty keeps the saved value. */
export function VaultProfileForm({ profile, busy, onSave, onCancel }: {
  profile?: VaultProfile; busy: boolean; onCancel: () => void; onSave: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const copy = appCopy.settings.vault;
  const labels: Record<string, string> = { name: copy.autofillName, family_name: copy.familyName, given_name: copy.givenName,
    name_latin: copy.latinName, name_latin_surname: copy.latinSurname, name_latin_given: copy.latinGiven, organization: copy.organization,
    country: copy.country, postal_code: copy.postalCode, region: copy.region, city: copy.city, address_line1: copy.addressLine1,
    address_line2: copy.addressLine2, nationality: copy.nationality, issuing_country: copy.issuingCountry, passport_expiry: copy.passportExpiry,
    phone: copy.phone, email: copy.email, birth_date: copy.birthDate, passport_number: copy.passportNumber };
  const [nickname, setNickname] = useState(profile?.nickname ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(DETAILS.map(key => [key, profile?.details[key] ?? ""])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [gender, setGender] = useState(profile?.details.gender ?? "");
  const [idOpen, setIdOpen] = useState(false);
  const ready = Boolean(nickname.trim() || values.name?.trim());
  async function save() {
    const input: Record<string, unknown> = { nickname: nickname.trim() || values.name?.trim(), gender, ...values };
    for (const key of SECRETS) if (secrets[key]?.trim()) input[key] = secrets[key]!.trim();
    if (await onSave(input)) setSecrets({});
  }
  const field = (key: string, secret = false) => (
    <Input key={key} aria-label={labels[key]} autoComplete="off" type={secret ? "password" : "text"}
      placeholder={secret && profile?.extras.includes(key) ? `${labels[key]} · ${copy.keepSecret}` : labels[key]}
      value={(secret ? secrets[key] : values[key]) ?? ""}
      onChange={(event) => (secret ? setSecrets : setValues)(previous => ({ ...previous, [key]: event.target.value }))} />
  );
  return (
    <Stack gap="sm" data-test-class="vault-profile-form">
      <Input aria-label={copy.nickname} placeholder={copy.nickname} autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} />
      {field("name")}
      <Stack as="span" align="row" gap="sm">{field("family_name")}{field("given_name")}</Stack>
      {field("name_latin")}
      <Stack as="span" align="row" gap="sm">{field("name_latin_surname")}{field("name_latin_given")}</Stack>
      <Stack as="span" align="row" gap="sm">{field("phone")}{field("email")}</Stack>
      {field("organization")}
      <Stack as="span" align="row" gap="sm">{field("country")}{field("postal_code")}</Stack>
      <Stack as="span" align="row" gap="sm">{field("region")}{field("city")}</Stack>
      {field("address_line1")}{field("address_line2")}{field("birth_date", true)}
      <Stack as="span" align="row" cross="center" gap="sm">
        <Typo.Caption tone="secondary">{copy.gender}</Typo.Caption>
        <SegmentedControl ariaLabel={copy.gender} value={gender}
          options={(["M", "F"] as const).map(value => ({ value, label: copy.genderOptions[value] }))} onValueChange={setGender} />
      </Stack>
      <Button size="sm" variant="ghost" aria-expanded={idOpen} data-test-class="vault-profile-id" onClick={() => setIdOpen(!idOpen)}>{copy.idSection}</Button>
      <Collapsible open={idOpen}>
        <Stack gap="sm">
          <Stack as="span" align="row" gap="sm">{field("passport_number", true)}{field("passport_expiry")}</Stack>
          <Stack as="span" align="row" gap="sm">{field("nationality")}{field("issuing_country")}</Stack>
        </Stack>
      </Collapsible>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
        <Button size="sm" disabled={!ready || busy} data-test-class="vault-profile-save" onClick={() => void save()}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
