import {
  OptionMenu,
  OptionMenuItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
        <ComposerControlButton
          data-test-class="access-button"
          icon={accessModeIcon(accessMode, 16)}
          style={accessModeStyle(accessMode)}
        >
          <span data-test-class="composer-control-label">
            {accessLabel(accessMode)}
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
      </PopoverContent>
    </Popover>
  );
}
