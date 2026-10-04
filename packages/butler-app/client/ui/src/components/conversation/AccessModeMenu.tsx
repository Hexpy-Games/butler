import { useAppLocale } from "@/app/copy.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ComposerControlButton } from "./ComposerControlButton";
import { dedupePermissions, GrantedPermissions } from "./GrantedPermissions";
import { AccessModeOptions } from "./AccessModeOptions";
import {
  accessLabel,
  accessPermissionTone,
  accessModeIcon,
} from "./accessModeUtils";

export function AccessModeMenu() {
  useAppLocale();
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
  const permissions = dedupePermissions(projection?.sessionId === sessionId ? projection.permissions ?? [] : []);

  return (
    <DropdownMenu open={accessMenuOpen} onOpenChange={setAccessMenuOpen}>
      <DropdownMenuTrigger asChild>
        <ComposerControlButton
          aria-label={`${appCopy.composer.permission}: ${accessLabel(accessMode)}${permissions.length ? ` · ${appCopy.interfaceTemplates.allowedCount(permissions.length)}` : ""}`}
          compact={permissions.length ? "label" : "icon"}
          data-test-class="access-button"
          icon={accessModeIcon(accessMode)}
          permissionTone={accessPermissionTone(accessMode)}
        >
          <span data-test-class="composer-control-label">
            {accessLabel(accessMode)}
            {permissions.length ? ` · ${appCopy.interfaceTemplates.allowedCount(permissions.length)}` : ""}
          </span>
        </ComposerControlButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        alignOffset={24}
        theme={appShellTheme(settings)}
        side="top"
        sideOffset={10}
      >
        <AccessModeOptions
          menu
          value={accessMode}
          onSelect={(item) => {
            handleAccessModeChange(item);
            setAccessMenuOpen(false);
          }}
        />
        <GrantedPermissions permissions={permissions} sessionId={sessionId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
