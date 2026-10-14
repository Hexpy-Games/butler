import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Input, Stack } from "@/butler-ds";
import type { VaultCard } from "./vaultApi";

/** Add or change a card. Secret fields start empty; on a change, empty keeps the saved value. */
export function VaultCardForm({ card, busy, onSave, onCancel }: {
  card?: VaultCard; busy: boolean; onCancel: () => void; onSave: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const copy = appCopy.settings.vault;
  const [nickname, setNickname] = useState(card?.nickname ?? "");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState(card ? `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(2)}` : "");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState(card?.holder_name ?? "");
  const [pin2, setPin2] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [month, year] = expiry.split("/").map(part => part.trim());
  const ready = Boolean((card || number.trim()) && month && year);
  const secret = (label: string) => card ? `${label} · ${copy.keepSecret}` : label;
  function input(): Record<string, unknown> {
    const out: Record<string, unknown> = { nickname: nickname.trim(), exp_month: Number(month), exp_year: Number(year), holder_name: holder.trim() };
    for (const [key, value] of [["number", number], ["cvc", cvc], ["pin2", pin2], ["owner_id", ownerId]] as const) if (value.trim()) out[key] = value.trim();
    return out;
  }
  async function save() {
    if (await onSave(input())) { setNumber(""); setCvc(""); setPin2(""); setOwnerId(""); }
  }
  return (
    <Stack gap="sm" data-test-class="vault-card-form">
      <Input aria-label={copy.nickname} placeholder={copy.nickname} autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} />
      <Input aria-label={copy.cardNumber} placeholder={card ? `•••• ${card.last4} · ${copy.keepSecret}` : copy.cardNumber} inputMode="numeric"
        autoComplete="off" type="password" value={number} onChange={(event) => setNumber(event.target.value)} />
      <Stack as="span" align="row" gap="sm">
        <Input aria-label={copy.expiry} placeholder={copy.expiry} inputMode="numeric" autoComplete="off" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        <Input aria-label={copy.cvc} placeholder={secret(copy.cvc)} inputMode="numeric" autoComplete="off" type="password" value={cvc} onChange={(event) => setCvc(event.target.value)} />
      </Stack>
      <Input aria-label={copy.holderName} placeholder={copy.holderName} autoComplete="off" value={holder} onChange={(event) => setHolder(event.target.value)} />
      <Input aria-label={copy.pin2} placeholder={secret(copy.pin2)} inputMode="numeric" autoComplete="off" type="password" value={pin2} onChange={(event) => setPin2(event.target.value)} />
      <Input aria-label={copy.ownerId} placeholder={secret(copy.ownerId)} inputMode="numeric" autoComplete="off" type="password" value={ownerId} onChange={(event) => setOwnerId(event.target.value)} />
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
        <Button size="sm" disabled={!ready || busy} data-test-class="vault-card-save" onClick={() => void save()}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
