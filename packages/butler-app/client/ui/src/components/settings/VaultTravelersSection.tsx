import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  Button, CardListItem, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton,
  MoreHorizontal, Plus, SettingsSection, Stack, Tooltip, Typo, UserRound,
} from "@/butler-ds";
import type { VaultTraveler } from "./vaultApi";
import type { useVault } from "./useVault";
import { VaultSitesField } from "./VaultSitesField";
import { VaultTravelerForm } from "./VaultTravelerForm";

type Vault = ReturnType<typeof useVault>;

/** Settings → Browser → Traveler details: names and the fields on file; identity numbers are never shown. */
export function VaultTravelersSection({ vault }: { vault: Vault }) {
  const copy = appCopy.settings.vault;
  const [editing, setEditing] = useState<string | null>(null);
  const available = vault.view?.available === true;
  const travelers = vault.view?.travelers ?? [];
  const save = (id: string | null) => async (input: Record<string, unknown>) => {
    const ok = await vault.save("travelers", id, input);
    if (ok) setEditing(null);
    return ok;
  };
  return (
    <SettingsSection id="travelers" kind="list" title={appCopy.settings.pageSections.travelers}
      state={vault.state === "ready" && !travelers.length && editing !== "new" ? "empty" : vault.state}
      emptyMessage={copy.emptyTravelers} onRetry={() => void vault.reload()}
      actions={(
        <Tooltip label={available ? copy.add : copy.unavailable}>
          <Button size="sm" variant="outline" data-test-class="vault-traveler-add" disabled={!available || editing !== null}
            onClick={() => setEditing("new")}><Plus size="sm" />{copy.add}</Button>
        </Tooltip>
      )}>
      {editing === "new" && <VaultTravelerForm busy={vault.busy !== null} onCancel={() => setEditing(null)} onSave={save(null)} />}
      {travelers.map(traveler => editing === traveler.id
        ? <VaultTravelerForm key={traveler.id} traveler={traveler} busy={vault.busy !== null} onCancel={() => setEditing(null)} onSave={save(traveler.id)} />
        : <VaultTravelerRow key={traveler.id} traveler={traveler} vault={vault} onEdit={() => setEditing(traveler.id)} />)}
    </SettingsSection>
  );
}

function VaultTravelerRow({ traveler, vault, onEdit }: { traveler: VaultTraveler; vault: Vault; onEdit: () => void }) {
  const copy = appCopy.settings.vault;
  const labels: Record<string, string> = { birth_date: copy.birthDate, passport_number: copy.passportNumber, rrn: copy.rrn };
  const stored = traveler.extras.map(key => (labels[key] ?? key).replace(/\s*\(.*\)$/u, "")).join(", ");
  return (
    <CardListItem data-test-class="vault-traveler-row" icon={<UserRound />} title={traveler.nickname}
      meta={traveler.details.name ?? ""}
      description={(
        <Stack as="span" gap="sm">
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            {stored && <Typo.Caption tone="secondary">{copy.storedFields(stored)}</Typo.Caption>}
            <Typo.Caption tone="secondary">{traveler.sites.length ? copy.allowedSites(traveler.sites.length) : copy.askEveryTime}</Typo.Caption>
          </Stack>
          <VaultSitesField sites={traveler.sites} label={copy.site}
            onChange={(next) => void vault.sites("travelers", traveler.id, traveler.sites, next)} />
        </Stack>
      )}
      actions={(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={traveler.nickname} disabled={vault.busy !== null}><MoreHorizontal size="sm" /></IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{copy.edit}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void vault.remove("travelers", traveler.id, traveler.nickname)}>{copy.delete}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
}
