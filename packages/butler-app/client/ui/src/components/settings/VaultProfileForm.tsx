import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, DisclosureRow, Field, FieldLabel, Grid, Input, SegmentedControl, Stack, Typo } from "@/butler-ds";
import type { VaultProfile } from "./vaultApi";

const DETAILS = ["name", "family_name", "given_name", "name_latin", "name_latin_surname", "name_latin_given", "organization",
  "country", "postal_code", "region", "city", "address_line1", "address_line2", "nationality", "issuing_country", "passport_expiry", "phone", "email"] as const;
const SECRETS = ["birth_date", "passport_number"] as const;

/** Secret fields start empty; on a change, empty keeps the saved value. */
export function VaultProfileForm({ profile, busy, onSave, onCancel }: {
  profile?: VaultProfile; busy: boolean; onCancel: () => void; onSave: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const copy = appCopy.settings.vault;
  const formId = useId();
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
    <Field key={key}>
      <FieldLabel htmlFor={`${formId}-${key}`}>{labels[key]}</FieldLabel>
      <Input id={`${formId}-${key}`} autoComplete="off" type={secret ? "password" : "text"}
        value={(secret ? secrets[key] : values[key]) ?? ""}
        onChange={(event) => (secret ? setSecrets : setValues)(previous => ({ ...previous, [key]: event.target.value }))} />
    </Field>
  );
  return (
    <Stack gap="md" data-test-class="vault-profile-form">
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{copy.nameSection}</Typo.Caption>
        <Field>
          <FieldLabel htmlFor={`${formId}-nickname`}>{copy.profileName}</FieldLabel>
          <Input id={`${formId}-nickname`} autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} />
        </Field>
        {field("name")}
        <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("family_name")}{field("given_name")}</Grid>
        <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("name_latin_surname")}{field("name_latin_given")}</Grid>
      </Stack>
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{copy.contactSection}</Typo.Caption>
        <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("phone")}{field("email")}</Grid>
      </Stack>
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{copy.addressSection}</Typo.Caption>
        <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("country")}{field("postal_code")}</Grid>
        <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("region")}{field("city")}</Grid>
        {field("address_line1")}{field("address_line2")}
      </Stack>
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{copy.otherSection}</Typo.Caption>
        {field("organization")}{field("birth_date", true)}
        <Field>
          <FieldLabel>{copy.gender}</FieldLabel>
          <SegmentedControl ariaLabel={copy.gender} value={gender}
            options={(["M", "F"] as const).map(value => ({ value, label: copy.genderOptions[value] }))} onValueChange={setGender} />
        </Field>
      </Stack>
      <DisclosureRow title={copy.idSection} open={idOpen} onToggle={() => setIdOpen(!idOpen)} data-test-class="vault-profile-id">
        <Stack gap="sm">
          <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("passport_number", true)}{field("passport_expiry")}</Grid>
          <Grid columns={{ base: "2", compact: "1" }} gap="sm">{field("nationality")}{field("issuing_country")}</Grid>
        </Stack>
      </DisclosureRow>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
        <Button size="sm" disabled={!ready || busy} data-test-class="vault-profile-save" onClick={() => void save()}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
