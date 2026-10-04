import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ConversationPermissionView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { DisclosureRow, OptionMenuSection, OptionMenuItem, ScrollArea, Stack, Typo, Tooltip } from "@/butler-ds";

export function GrantedPermissions({ permissions, sessionId }: {
  permissions: ConversationPermissionView[]; sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [failed, setFailed] = useState(false);
  const revoke = useButlerStore(store => store.revokeConversationPermission);
  const grants = [...new Map(permissions.map(item => [item.grant_ref, item])).values()];
  if (!grants.length) return null;
  return <DisclosureRow title={appCopy.interfaceTemplates.grantedItems(grants.length)}
    open={open} onToggle={() => setOpen(value => !value)} data-test-class="granted-permissions">
    <ScrollArea maxHeight="xs" dataTestClass="granted-permissions-scroll">
      <OptionMenuSection title={null}>
        {grants.map(item => {
          const label = appCopy.guided.tools[item.capability ?? ""] ?? appCopy.guided.tools.fallback;
          const target = item.target || appCopy.interfaceDetails.allowedConversation;
          return <OptionMenuItem key={item.grant_ref} data-test-class="granted-permission"
            label={appCopy.interfaceTemplates.revoke(label)} disabled={revoking !== undefined}
            descriptionPlacement="block" description={<Stack gap="xs">
              <Tooltip wrap label={target}><Typo.Caption truncate>{target}</Typo.Caption></Tooltip>
              {item.cwd ? <Tooltip wrap label={item.cwd}><Typo.Caption truncate>{item.cwd}</Typo.Caption></Tooltip> : null}
              <Typo.Caption tone="secondary" wrap="normal">{item.capability === "run_command" ? appCopy.interfaceDetails.grantCommandScope : appCopy.interfaceDetails.grantTargetScope}</Typo.Caption>
            </Stack>}
            onClick={async () => {
              setRevoking(item.grant_ref); setFailed(false);
              try { setFailed(!await revoke(item.grant_ref, sessionId ?? undefined)); }
              finally { setRevoking(undefined); }
            }} />;
        })}
      </OptionMenuSection>
    </ScrollArea>
    {failed ? <Typo.Caption role="alert">{appCopy.interfaceDetails.revokeFailed}</Typo.Caption> : null}
  </DisclosureRow>;
}
