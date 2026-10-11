import { Stack, TagField, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

/** Sites where a saved item (or a purchase) goes without asking. Typing a site adds it. */
export function VaultSitesField({ sites, label, onChange }: { sites: readonly string[]; label: string; onChange: (next: string[]) => void }) {
  const copy = appCopy.settings.vault;
  return <Stack as="span" gap="xs">
    <Typo.Caption tone="secondary">{label}</Typo.Caption>
    <TagField value={sites} onChange={onChange} suggestions={[]} label={label} placeholder={copy.sitePlaceholder}
      removeLabel={copy.removeSite} createLabel={(name) => `${copy.addSite} · ${name}`} maxLength={253} />
  </Stack>;
}
