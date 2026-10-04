import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { ConversationPermissionView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { commandProgram } from "../../../../../../butler-i18n/src/index.ts";
import { DropdownMenuItem, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, ScrollArea, Stack, Tag, Typo, Tooltip } from "@/butler-ds";

function permissionKey(item: ConversationPermissionView) {
  return JSON.stringify([item.capability, item.target, item.cwd, item.description]);
}

export function dedupePermissions(permissions: ConversationPermissionView[]) {
  return [...new Map(permissions.map(item => [
    permissionKey(item), item,
  ])).values()];
}

export function GrantedPermissions({ permissions, sessionId }: {
  permissions: ConversationPermissionView[]; sessionId: string | null;
}) {
  const [revoking, setRevoking] = useState<string>();
  const [failed, setFailed] = useState(false);
  const revoke = useButlerStore(store => store.revokeConversationPermission);
  const grants = dedupePermissions(permissions);
  if (!grants.length) return null;
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger data-test-class="granted-permissions">
      {appCopy.interfaceTemplates.grantedItems(grants.length)}
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal><DropdownMenuSubContent sideOffset={12} data-test-class="granted-permissions-submenu">
      <ScrollArea maxHeight="xs" dataTestClass="granted-permissions-scroll">
        {grants.map(item => {
          const command = item.capability === "run_command";
          const kind = command ? appCopy.interfaceStatus.command
            : appCopy.guided.tools[item.capability ?? ""] ?? item.capability ?? item.title;
          const target = item.target || item.title;
          const label = `${kind}: ${command ? commandProgram(target) : target}`;
          return <DropdownMenuItem key={item.grant_ref} data-test-class="granted-permission"
            aria-label={appCopy.interfaceTemplates.revoke(label)} disabled={revoking !== undefined}
            onSelect={async event => {
              event.preventDefault();
              setRevoking(item.grant_ref); setFailed(false);
              try {
                const refs = [...new Set(permissions.filter(grant => permissionKey(grant) === permissionKey(item)).map(grant => grant.grant_ref))];
                const results = await Promise.all(refs.map(ref => revoke(ref, sessionId ?? undefined)));
                setFailed(results.some(result => !result));
              }
              finally { setRevoking(undefined); }
            }}>
            <Stack gap="xs">
              <Tooltip wrap label={target}><Typo.Label>{label}</Typo.Label></Tooltip>
              {item.cwd && item.cwd !== target ? <Tooltip wrap label={item.cwd}><Typo.Caption truncate>{item.cwd}</Typo.Caption></Tooltip> : null}
              <Tooltip wrap label={command ? appCopy.interfaceDetails.grantCommandScope : appCopy.interfaceDetails.grantTargetScope}>
                <Tag size="sm">{appCopy.interfaceDetails.grantScopeTag}</Tag>
              </Tooltip>
            </Stack>
          </DropdownMenuItem>;
        })}
      </ScrollArea>
      {failed ? <Typo.Caption role="alert">{appCopy.interfaceDetails.revokeFailed}</Typo.Caption> : null}
    </DropdownMenuSubContent></DropdownMenuPortal>
  </DropdownMenuSub>;
}
