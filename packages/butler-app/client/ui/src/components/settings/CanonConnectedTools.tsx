import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { decideCanonGrant, useCanonGrants, type CanonGrant } from "@/app/canonTrust.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Box, Button, ListRow, SettingsSection, Stack, Tag } from "@/butler-ds";
export function CanonConnectedTools() {
  useAppLocale();
  const { grants, failed, refresh } = useCanonGrants();
  const [busy, setBusy] = useState<string | null>(null);
  const copy = appCopy.canon.mcp;
  const revoke = async (grant: CanonGrant) => {
    if (busy) return;
    setBusy(grant.id);
    try {
      await decideCanonGrant(grant.id, "revoke"); await refresh();
      notifyStatus(grant.state === "denied" ? copy.deleted : copy.revoked);
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(null); }
  };
  return <SettingsSection id="canon-connected-tools" kind="list" title={copy.connectedTools}
    state={failed ? "error" : grants === null ? "loading" : grants.length ? "ready" : "empty"}
    emptyMessage={copy.noTools} onRetry={() => void refresh()}>
    {grants?.map(grant => <Stack key={grant.id} align="row" cross="center" gap="sm" wrap>
      <Box grow minWidth="0"><ListRow title={grant.client_title} description={copy.capabilityCount(grant.state === "allowed" ? grant.allowed.length : grant.requested.length)} /></Box>
      <Tag>{copy.states[grant.state]}</Tag>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void revoke(grant)}>{grant.state === "denied" ? copy.remove : copy.revoke}</Button>
    </Stack>)}
  </SettingsSection>;
}
