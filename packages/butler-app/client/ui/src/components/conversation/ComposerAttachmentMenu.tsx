import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import {
  IconButton,
  ListChecks,
  MessageSquarePlus,
  OptionMenu,
  OptionMenuItem,
  OptionMenuSection,
  Paperclip,
  Plus,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import { activeProjectId } from "./composerProjectContext";
import { ComposerProjectDocumentMenu } from "./ComposerProjectDocumentMenu";

export function ComposerAttachmentMenu() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const navigation = useButlerStore((state) => state.navigation);
  const settings = useButlerStore((state) => state.settings);
  const projectId = activeProjectId(navigation, activeChatId);
  const uploadingCount = useComposerStore((store) => store.uploadingCount);
  const planMode = useComposerStore((store) => store.planMode);
  const handlePlanModeChange = useComposerStore(
    (store) => store.handlePlanModeChange,
  );
  const openAttachmentPicker = useComposerStore(
    (store) => store.openAttachmentPicker,
  );
  const [open, setOpen] = useState(false);
  const themeClass = appThemeClasses(settings);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          data-test-class="attachment-button"
          label={appCopy.composer.featureDrawer}
          disabled={uploadingCount > 0}
        >
          <Plus size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={themeClass}
        data-menu-size="content"
        onOpenAutoFocus={(event) => {
          const drawer = event.currentTarget as HTMLElement;
          drawer.querySelector<HTMLButtonElement>(
            '[data-slot="option-menu-item"]:not(:disabled)',
          )?.focus();
        }}
        side="top"
        sideOffset={10}
      >
        <OptionMenu title={appCopy.composer.featureDrawer} size="fit">
          <OptionMenuSection title={appCopy.composer.attachments}>
            {projectId ? (
              <ComposerProjectDocumentMenu
                className={themeClass}
                projectId={projectId}
                onClose={() => setOpen(false)}
              />
            ) : null}
            <OptionMenuItem
              icon={<Paperclip size={15} />}
              label={appCopy.composer.attachFile}
              onClick={() => {
                openAttachmentPicker();
                setOpen(false);
              }}
            />
          </OptionMenuSection>
          <OptionMenuSection title={appCopy.composer.responseMode}>
            <OptionMenuItem
              icon={<MessageSquarePlus size={15} />}
              label={appCopy.composer.normal}
              selected={!planMode}
              onClick={() => {
                handlePlanModeChange(false);
                setOpen(false);
              }}
            />
            <OptionMenuItem
              icon={<ListChecks size={15} />}
              label={appCopy.composer.plan}
              selected={planMode}
              onClick={() => {
                handlePlanModeChange(true);
                setOpen(false);
              }}
            />
          </OptionMenuSection>
        </OptionMenu>
      </PopoverContent>
    </Popover>
  );
}
