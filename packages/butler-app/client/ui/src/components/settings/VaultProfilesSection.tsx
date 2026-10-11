import { useEffect, useState } from "react";
import { appCopy, getAppLocale } from "@/app/copy.ts";
import {
  Button, CardListItem, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton,
  MoreHorizontal, Plus, SettingsSection, Stack, Tooltip, Typo, UserRound,
} from "@/butler-ds";
import { notifyError } from "@/app/notifications.ts";
import { revealProfile, type VaultProfile } from "./vaultApi";
import type { useVault } from "./useVault";
import { VaultSitesField } from "./VaultSitesField";
import { VaultProfileForm } from "./VaultProfileForm";

type Vault = ReturnType<typeof useVault>;

/** Settings → Browser → Profile details: names and the fields on file; identity numbers are never shown. */
export function VaultProfilesSection({ vault }: { vault: Vault }) {
  const copy = appCopy.settings.vault;
  const [editing, setEditing] = useState<string | null>(null);
  const available = vault.view?.available === true;
  const profiles = vault.view?.profiles ?? [];
  const save = (id: string | null) => async (input: Record<string, unknown>) => {
    const ok = await vault.save("profiles", id, input);
    if (ok) setEditing(null);
    return ok;
  };
  return (
    <SettingsSection id="profiles" kind="list" title={appCopy.settings.pageSections.profiles}
      state={vault.state === "ready" && !profiles.length && editing !== "new" ? "empty" : vault.state}
      emptyMessage={copy.emptyProfiles} onRetry={() => void vault.reload()}
      actions={(
        <Tooltip label={available ? copy.add : copy.unavailable}>
          <Button size="sm" variant="outline" data-test-class="vault-profile-add" disabled={!available || editing !== null}
            onClick={() => setEditing("new")}><Plus size="sm" />{copy.add}</Button>
        </Tooltip>
      )}>
      {editing === "new" && <VaultProfileForm busy={vault.busy !== null} onCancel={() => setEditing(null)} onSave={save(null)} />}
      {profiles.map(profile => editing === profile.id
        ? <VaultProfileForm key={profile.id} profile={profile} busy={vault.busy !== null} onCancel={() => setEditing(null)} onSave={save(profile.id)} />
        : <VaultProfileRow key={profile.id} profile={profile} vault={vault} onEdit={() => setEditing(profile.id)} />)}
    </SettingsSection>
  );
}

function VaultProfileRow({ profile, vault, onEdit }: { profile: VaultProfile; vault: Vault; onEdit: () => void }) {
  const copy = appCopy.settings.vault;
  const [shown, setShown] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), 20_000);
    return () => clearTimeout(timer);
  }, [shown]);
  async function reveal() {
    setRevealing(true);
    try { setShown((await revealProfile(profile.id, getAppLocale())).number); }
    catch (error) { notifyError(error, copy.failed); }
    finally { setRevealing(false); }
  }
  const labels: Record<string, string> = { birth_date: copy.birthDate, passport_number: copy.passportNumber, rrn: copy.rrn };
  const stored = profile.extras.map(key => (labels[key] ?? key).replace(/\s*\(.*\)$/u, "")).join(", ");
  return (
    <CardListItem data-test-class="vault-profile-row" icon={<UserRound />} title={profile.nickname}
      meta={profile.details.name ?? ""}
      description={(
        <Stack as="span" gap="sm">
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            {stored && <Typo.Caption tone="secondary">{copy.storedFields(stored)}</Typo.Caption>}
            <Typo.Caption tone="secondary">{profile.sites.length ? copy.allowedSites(profile.sites.length) : copy.askEveryTime}</Typo.Caption>
          </Stack>
          {profile.extras.includes("passport_number") && <Stack as="span" align="row" gap="xs">
            {shown && <Typo.Caption>{shown}</Typo.Caption>}
            <Tooltip label={vault.view?.reveal_available ? copy.reveal : copy.revealUnavailable}>
              <Button size="sm" variant="outline" disabled={!vault.view?.reveal_available || revealing} data-test-class="vault-profile-reveal"
                onClick={() => shown ? setShown(null) : void reveal()}>{shown ? copy.hide : copy.reveal}</Button>
            </Tooltip>
          </Stack>}
          <VaultSitesField sites={profile.sites} label={copy.site}
            onChange={(next) => void vault.sites("profiles", profile.id, profile.sites, next)} />
        </Stack>
      )}
      actions={(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={profile.nickname} disabled={vault.busy !== null}><MoreHorizontal size="sm" /></IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{copy.edit}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void vault.remove("profiles", profile.id, profile.nickname)}>{copy.delete}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
}
