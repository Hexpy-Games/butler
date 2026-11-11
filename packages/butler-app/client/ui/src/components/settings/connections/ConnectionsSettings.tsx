import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, CardListItem, IconButton, Plus, SettingsPage, SettingsSection, Tooltip, X } from "@/butler-ds";
import { MailAccountForm } from "./MailAccountForm";
import { useConnections } from "./useConnections";

export function ConnectionsSettings() {
  const copy = appCopy.settings.connections;
  const connections = useConnections();
  const [adding, setAdding] = useState(false);
  const accounts = connections.view?.connectors.filter(c => c.plugin === "mail" && c.connector === "mail")
    .flatMap(c => c.accounts).filter(account => account.enabled === true) ?? [];
  return <SettingsPage labels={appCopy.settings.sectionState}>
    <SettingsSection id="mail" kind="list" title={appCopy.settings.pageSections.mail}
      state={connections.state === "ready" && !accounts.length && !adding ? "empty" : connections.state}
      emptyMessage={copy.empty} onRetry={() => void connections.reload()}
      actions={<Button size="sm" variant="outline" disabled={adding || connections.busy} onClick={() => setAdding(true)}><Plus size="sm" />{copy.add}</Button>}>
      {adding && <MailAccountForm busy={connections.busy} onCancel={() => setAdding(false)}
        onSave={async input => { const saved = await connections.add(input); if (saved) setAdding(false); return saved; }} />}
      {accounts.map(account => <CardListItem key={account.id} title={account.fields.address}
        description={account.state === "connected" ? copy.connected : ["connecting", "reconnecting"].includes(account.state) ? copy.connecting
          : account.state === "crashed" ? `${copy.disconnected} · ${copy.checkAccount}` : copy.disconnected}
        actions={<ButtonContainer size="sm">
          {account.state === "crashed" && <Button size="sm" variant="outline" disabled={connections.busy} onClick={() => void connections.retry(account.id)}>{copy.retry}</Button>}
          <Tooltip label={copy.remove}><IconButton label={copy.remove} disabled={connections.busy} onClick={() => void connections.remove(account.id)}><X size="sm" /></IconButton></Tooltip>
        </ButtonContainer>} />)}
    </SettingsSection>
    <SettingsSection id="connector-rules" kind="list" title={appCopy.settings.pageSections.connectorRules}
      state={connections.state === "ready" && !connections.rules.length ? "empty" : connections.state}
      emptyMessage={copy.noRules} onRetry={() => void connections.reload()}>
      {connections.rules.map(rule => <CardListItem key={rule.id} title={rule.title}
        actions={<Tooltip label={copy.remove}><IconButton label={copy.remove} disabled={connections.busy} onClick={() => void connections.deleteRule(rule.id)}><X size="sm" /></IconButton></Tooltip>} />)}
    </SettingsSection>
  </SettingsPage>;
}
