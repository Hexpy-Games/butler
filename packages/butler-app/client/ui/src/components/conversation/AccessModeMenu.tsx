import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import {
  OptionMenu,
  OptionMenuItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ComposerControlButton } from "./ComposerControlButton";
import {
  accessDescription,
  accessLabel,
  accessModeStyle,
  accessModeTone,
  accessModeIcon,
} from "./accessModeUtils";

export function AccessModeMenu() {
  useAppLocale();
  const [revoking, setRevoking] = useState<string>();
  const [revokeFailed, setRevokeFailed] = useState(false);
  const accessMode = useComposerStore((store) => store.accessMode);
  const accessMenuOpen = useComposerStore((store) => store.accessMenuOpen);
  const setAccessMenuOpen = useComposerStore(
    (store) => store.setAccessMenuOpen,
  );
  const handleAccessModeChange = useComposerStore(
    (store) => store.handleAccessModeChange,
  );
  const settings = useButlerStore((store) => store.settings);
  const sessionId = useButlerStore((store) => store.activeChatId);
  const projection = useButlerStore((store) => store.authorityApprovals);
  const permissions = projection?.sessionId === sessionId ? projection.permissions ?? [] : [];
  const revoke = useButlerStore((store) => store.revokeConversationPermission);

  return (
    <Popover open={accessMenuOpen} onOpenChange={setAccessMenuOpen}>
      <PopoverTrigger asChild>
        <ComposerControlButton
          aria-label={`${appCopy.composer.permission}: ${accessLabel(accessMode)}${permissions.length ? ` · ${appCopy.interfaceTemplates.allowedCount(permissions.length)}` : ""}`}
          compact={permissions.length ? "label" : "icon"}
          data-test-class="access-button"
          icon={accessModeIcon(accessMode, 16)}
          style={accessModeStyle(accessMode)}
        >
          <span data-test-class="composer-control-label">
            {accessLabel(accessMode)}
            {permissions.length ? ` · ${appCopy.interfaceTemplates.allowedCount(permissions.length)}` : ""}
          </span>
        </ComposerControlButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={appThemeClasses(settings)}
        data-menu-size="compact"
        side="top"
        sideOffset={10}
      >
        <OptionMenu title={appCopy.composer.permission}>
          {(["full_access", "ask_first", "read_only"] satisfies AccessMode[]).map(
            (item) => (
              <OptionMenuItem
                description={accessDescription(item)}
                descriptionPlacement="block"
                icon={accessModeIcon(item)}
                key={item}
                label={accessLabel(item)}
                selected={item === accessMode}
                style={accessModeStyle(item)}
                tone={accessModeTone(item)}
                onClick={() => {
                  handleAccessModeChange(item);
                  setAccessMenuOpen(false);
                }}
              />
            ),
          )}
        </OptionMenu>
        {permissions.length ? <OptionMenu title={appCopy.interfaceDetails.allowedConversation}>
          {permissions.map((permission) => <OptionMenuItem
            key={permission.grant_ref}
            label={appCopy.interfaceTemplates.revoke(permission.title)}
            description={permission.description}
            descriptionPlacement="block"
            disabled={revoking !== undefined}
            onClick={async () => {
              setRevoking(permission.grant_ref); setRevokeFailed(false);
              const applied = await revoke(permission.grant_ref, sessionId);
              setRevoking(undefined); setRevokeFailed(!applied);
            }}
          />)}
        </OptionMenu> : null}
        {revokeFailed ? <Typo.Caption role="alert">{appCopy.interfaceDetails.revokeFailed}</Typo.Caption> : null}
      </PopoverContent>
    </Popover>
  );
}
