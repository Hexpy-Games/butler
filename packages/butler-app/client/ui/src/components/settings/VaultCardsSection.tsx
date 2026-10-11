import { useEffect, useState } from "react";
import { appCopy, getAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import {
  Button, CardListItem, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton, Lock,
  MoreHorizontal, Plus, SettingsSection, Stack, Tag, Tooltip, Typo,
} from "@/butler-ds";
import { revealCard, type VaultCard } from "./vaultApi";
import type { useVault } from "./useVault";
import { VaultCardForm } from "./VaultCardForm";
import { VaultSitesField } from "./VaultSitesField";

type Vault = ReturnType<typeof useVault>;
const REVEAL_MS = 20_000;

/** Settings → Browser → Payment methods: masked cards, the sites each fills without asking. */
export function VaultCardsSection({ vault }: { vault: Vault }) {
  const copy = appCopy.settings.vault;
  const [editing, setEditing] = useState<string | null>(null);
  const available = vault.view?.available === true;
  const cards = vault.view?.cards ?? [];
  return (
    <SettingsSection id="payment-methods" kind="list" title={appCopy.settings.pageSections.paymentMethods}
      state={vault.state === "ready" && !cards.length && editing !== "new" ? "empty" : vault.state}
      emptyMessage={copy.emptyCards} onRetry={() => void vault.reload()}
      actions={(
        <Tooltip label={available ? copy.add : copy.unavailable}>
          <Button size="sm" variant="outline" data-test-class="vault-card-add" disabled={!available || editing !== null}
            onClick={() => setEditing("new")}><Plus size="sm" />{copy.add}</Button>
        </Tooltip>
      )}>
      {editing === "new" && <VaultCardForm busy={vault.busy !== null} onCancel={() => setEditing(null)}
        onSave={async (input) => { const ok = await vault.save("cards", null, input); if (ok) setEditing(null); return ok; }} />}
      {cards.map(card => editing === card.id
        ? <VaultCardForm key={card.id} card={card} busy={vault.busy !== null} onCancel={() => setEditing(null)}
          onSave={async (input) => { const ok = await vault.save("cards", card.id, input); if (ok) setEditing(null); return ok; }} />
        : <VaultCardRow key={card.id} card={card} vault={vault} onEdit={() => setEditing(card.id)} />)}
    </SettingsSection>
  );
}

function expired(card: VaultCard) {
  const now = new Date();
  return card.exp_year < now.getFullYear() || card.exp_year === now.getFullYear() && card.exp_month < now.getMonth() + 1;
}

function VaultCardRow({ card, vault, onEdit }: { card: VaultCard; vault: Vault; onEdit: () => void }) {
  const copy = appCopy.settings.vault;
  const [shown, setShown] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  async function reveal() {
    setRevealing(true);
    try { setShown((await revealCard(card.id, getAppLocale())).number.replace(/(\d{4})(?=\d)/gu, "$1 ")); }
    catch (error) { notifyError(error, copy.failed); }
    finally { setRevealing(false); }
  }
  const revealable = vault.view?.reveal_available === true;
  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(2)}`;
  return (
    <CardListItem data-test-class="vault-card-row" icon={<Lock />} title={card.nickname}
      meta={shown ?? `•••• ${card.last4} · ${expiry}`}
      description={(
        <Stack as="span" gap="sm">
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            <Typo.Caption tone="secondary">{[card.holder_name, card.sites.length ? copy.allowedSites(card.sites.length) : copy.askEveryTime].filter(Boolean).join(" · ")}</Typo.Caption>
            {expired(card) && <Tag size="sm" tone="warning">{copy.expired}</Tag>}
          </Stack>
          <VaultSitesField sites={card.sites} label={copy.site} onChange={(next) => void vault.sites("cards", card.id, card.sites, next)} />
        </Stack>
      )}
      actions={(
        <Stack as="span" align="row" cross="center" gap="xs">
          <Tooltip label={revealable ? shown ? copy.hide : copy.reveal : copy.revealUnavailable}>
            <Button size="sm" variant="outline" disabled={!revealable || revealing} data-test-class="vault-card-reveal"
              onClick={() => shown ? setShown(null) : void reveal()}>{shown ? copy.hide : copy.reveal}</Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={card.nickname} disabled={vault.busy !== null}><MoreHorizontal size="sm" /></IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>{copy.edit}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void vault.remove("cards", card.id, card.nickname)}>{copy.delete}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Stack>
      )}
    />
  );
}
