import { appCopy, getAppLocale, useAppLocale } from "@/app/copy";
import { Button, ListRow, Stack, Tooltip, UserRound } from "@/butler-ds";
import type { useConnectedAccounts } from "./hooks/useConnectedAccounts";
import type { OauthCredential } from "./securityApi";

function accountMeta(credential: OauthCredential): string {
  const copy = appCopy.settings.connectedAccounts;
  const format = new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "short" });
  return [
    credential.obtained_at === null ? null : copy.obtained(format.format(credential.obtained_at * 1000)),
    credential.expires_at === null ? null : copy.expires(format.format(credential.expires_at * 1000)),
  ].filter(Boolean).join(" · ");
}

export function ConnectedAccountRows({ accounts }: { accounts: ReturnType<typeof useConnectedAccounts> }) {
  useAppLocale();
  const copy = appCopy.settings.connectedAccounts;
  return accounts.credentials.map((credential) => {
    const name = credential.kind === "legacy_sign_in" ? copy.provider : credential.label ?? copy.provider;
    return (
      <Stack key={credential.id} align="row" cross="center" gap="sm" wrap>
        <Stack grow minWidth="0">
          <ListRow icon={<UserRound size="md" />} title={name}
            description={copy.kind[credential.kind]} meta={accountMeta(credential)} />
        </Stack>
        <Tooltip label={accounts.busy ? appCopy.settings.security.working : copy.signOutOf(name)}>
          <Button size="sm" variant="outline" disabled={accounts.busy}
            aria-label={copy.signOutOf(name)} onClick={() => void accounts.remove(credential, name)}>
            {copy.signOut}
          </Button>
        </Tooltip>
      </Stack>
    );
  });
}
