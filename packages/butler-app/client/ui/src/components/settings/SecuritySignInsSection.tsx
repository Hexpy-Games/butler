import { useState } from "react";
import { appCopy, getAppLocale } from "@/app/copy.ts";
import {
  Button, ButtonContainer, CardListItem, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Globe2, IconButton, Input, MoreHorizontal, Plus, SegmentedControl, SettingsSection, Stack, Switch, Tag, Tooltip, Typo,
} from "@/butler-ds";
import { canSignOut, type SignInPolicy, type SignInSiteRow } from "./signInsApi";
import { useSignIns } from "./useSignIns";
import { SecurityBrowserImportSection } from "./SecurityBrowserImportSection";

function since(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const format = new Intl.RelativeTimeFormat(getAppLocale(), { numeric: "auto" });
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), "hour");
  return format.format(-Math.floor(seconds / 86400), "day");
}

/** Sign-ins, then import from another browser (which needs the same keychain). */
export function SecuritySignInsSections() {
  const signIns = useSignIns();
  return <>
    <SecuritySignInsSection signIns={signIns} />
    <SecurityBrowserImportSection keychain={signIns.view?.available === true} onImported={() => void signIns.reload()} />
  </>;
}

/** Settings → Security → Sign-ins: saved sign-ins and Butler's per-site access. Passwords are never shown. */
function SecuritySignInsSection({ signIns }: { signIns: ReturnType<typeof useSignIns> }) {
  const copy = appCopy.settings.signIns;
  const [adding, setAdding] = useState(false);
  const available = signIns.view?.available === true;
  const rows = signIns.view?.sites ?? [];
  return (
    <SettingsSection id="sign-ins" kind="list" title={appCopy.settings.pageSections.signIns}
      state={signIns.state === "ready" && !rows.length && !adding ? "empty" : signIns.state}
      emptyMessage={copy.empty} onRetry={() => void signIns.reload()}
      actions={(
        <Tooltip label={available ? copy.add : copy.unavailable}>
          <Button size="sm" variant="outline" data-test-class="sign-in-add" disabled={!available || adding}
            onClick={() => setAdding(true)}><Plus size="sm" />{copy.add}</Button>
        </Tooltip>
      )}>
      {adding && <SignInAddForm busy={signIns.busy !== null} onCancel={() => setAdding(false)}
        onSave={async (input) => { if (await signIns.add(input)) setAdding(false); }} />}
      {rows.map(row => <SignInRow key={row.site} row={row} busy={signIns.busy !== null} actions={signIns} />)}
    </SettingsSection>
  );
}

function SignInRow({ row, busy, actions }: { row: SignInSiteRow; busy: boolean; actions: ReturnType<typeof useSignIns> }) {
  const copy = appCopy.settings.signIns;
  const used = row.entry?.last_used_at;
  const policies: SignInPolicy[] = ["always", "ask", "never"];
  return (
    <CardListItem data-test-class="sign-in-row" icon={<Globe2 />} title={row.site}
      meta={used ? copy.lastUsed(since(used)) : copy.notUsed}
      description={(
        <Stack as="span" gap="sm">
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            <Typo.Caption tone="secondary">{row.entry?.username ?? copy.noPassword}</Typo.Caption>
            {row.conversations > 0 && <Tag size="sm" tone="neutral">{copy.conversations(row.conversations)}</Tag>}
          </Stack>
          {row.entry && (
            <Stack as="span" align="row" cross="center" gap="sm" wrap>
              <Typo.Caption tone="secondary">{copy.policyLabel}</Typo.Caption>
              <SegmentedControl ariaLabel={copy.policyLabel} value={row.entry.policy}
                options={policies.map(value => ({ value, label: copy.policy[value] }))}
                onValueChange={(value) => void actions.policy(row.entry!.id, value as SignInPolicy)} />
            </Stack>
          )}
          <Stack as="span" align="row" cross="center" gap="sm">
            <Switch aria-label={copy.allConversations} checked={row.all_conversations} disabled={busy}
              onCheckedChange={(value) => void actions.allConversations(row.site, value)} />
            <Typo.Caption tone="secondary">{copy.allConversations}</Typo.Caption>
          </Stack>
        </Stack>
      )}
      actions={(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={row.site} disabled={busy}><MoreHorizontal size="sm" /></IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.entry && <DropdownMenuItem onSelect={() => void actions.deletePassword(row)}>{copy.deletePassword}</DropdownMenuItem>}
            {canSignOut() && <DropdownMenuItem onSelect={() => void actions.signOut(row.site)}>{copy.signOut}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void actions.revoke(row.site)}>{copy.revoke}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
}

function SignInAddForm({ busy, onSave, onCancel }: {
  busy: boolean; onCancel: () => void; onSave: (input: { site: string; username: string; password: string }) => Promise<void>;
}) {
  const copy = appCopy.settings.signIns;
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const ready = Boolean(site.trim() && username.trim() && password);
  return (
    <Stack gap="sm" data-test-class="sign-in-add-form">
      <Input aria-label={copy.site} placeholder={copy.sitePlaceholder} autoComplete="off" spellCheck={false}
        value={site} onChange={(event) => setSite(event.target.value)} />
      <Input aria-label={copy.username} placeholder={copy.username} autoComplete="off" spellCheck={false}
        value={username} onChange={(event) => setUsername(event.target.value)} />
      <Input aria-label={copy.password} placeholder={copy.password} type="password" autoComplete="new-password"
        value={password} onChange={(event) => setPassword(event.target.value)} />
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
        <Button size="sm" disabled={!ready || busy}
          onClick={() => void onSave({ site: site.trim(), username: username.trim(), password }).then(() => setPassword(""))}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
