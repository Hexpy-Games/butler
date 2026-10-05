import { useComposerMenuFocus } from "./hooks/useComposerMenuFocus";
import { useAppLocale } from "@/app/copy.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ComposerControlButton } from "./ComposerControlButton";
import { AccessModeOptions } from "./AccessModeOptions";
import {
  accessLabel,
  accessPermissionTone,
  accessModeIcon,
} from "./accessModeUtils";

export function AccessModeMenu() {
  useAppLocale();
  const menuFocus = useComposerMenuFocus();
  const accessMode = useComposerStore((store) => store.accessMode);
  const accessMenuOpen = useComposerStore((store) => store.accessMenuOpen);
  const setAccessMenuOpen = useComposerStore(
    (store) => store.setAccessMenuOpen,
  );
  const handleAccessModeChange = useComposerStore(
    (store) => store.handleAccessModeChange,
  );
  const settings = useButlerStore((store) => store.settings);

  return (
    <Popover open={accessMenuOpen} onOpenChange={setAccessMenuOpen}>
      <PopoverTrigger asChild>
        <ComposerControlButton {...menuFocus.trigger} surface="glass" size="lg"
          aria-label={`${appCopy.composer.permission}: ${accessLabel(accessMode)}`}
          compact="icon"
          data-test-class="access-button"
          icon={accessModeIcon(accessMode)}
          permissionTone={accessPermissionTone(accessMode)}
        >
          <span data-test-class="composer-control-label">
            {accessLabel(accessMode)}
          </span>
        </ComposerControlButton>
      </PopoverTrigger>
      <PopoverContent
        {...menuFocus.content}
        align="start"
        theme={appShellTheme(settings)}
        data-menu-size="compact"
        side="top"
        sideOffset={10}
      >
        <AccessModeOptions
          value={accessMode}
          onSelect={(item) => {
            handleAccessModeChange(item);
            setAccessMenuOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
