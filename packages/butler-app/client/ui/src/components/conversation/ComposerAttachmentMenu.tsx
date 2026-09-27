import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import {
  IconButton,
  ImageIcon,
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
import { activeProjectId } from "./composerProjectContext";
import { useComposerStore } from "./composerStore";
import { ComposerProjectDocumentMenu } from "./ComposerProjectDocumentMenu";
import { composerImagePolicy } from "./composerImagePolicy";

export function ComposerAttachmentMenu() {
  useAppLocale();
  const activeChatId = useComposerStore((state) => state.draftSessionId);
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
  const imagesAccepted = useComposerStore((store) => composerImagePolicy(store.activeModel).accepts);
  const [open, setOpen] = useState(false);
  const theme = appShellTheme(settings);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          data-test-class="attachment-button"
          disabled={uploadingCount > 0}
          label={appCopy.composer.featureDrawer}
        >
          <Plus size="md" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        theme={theme}
        data-menu-size="content"
        onOpenAutoFocus={(event) => {
          const menu = event.currentTarget as HTMLElement;
          menu
            .querySelector<HTMLButtonElement>(
              '[data-slot="option-menu-item"]:not(:disabled):not([aria-disabled="true"])',
            )
            ?.focus();
        }}
        side="top"
        sideOffset={10}
      >
        <OptionMenu title={appCopy.composer.featureDrawer} size="fit">
          <OptionMenuSection title={appCopy.composer.attachments}>
            {projectId ? (
              <ComposerProjectDocumentMenu
                theme={theme}
                onClose={() => setOpen(false)}
                projectId={projectId}
              />
            ) : null}
            <OptionMenuItem
              icon={<Paperclip size="md" />}
              label={appCopy.composer.attachFile}
              onClick={() => {
                openAttachmentPicker();
                setOpen(false);
              }}
            />
            <OptionMenuItem
              icon={<ImageIcon size="md" />}
              label={appCopy.composer.attachImage}
              disabledReason={imagesAccepted ? undefined : appCopy.composer.imagesUnsupported}
              onClick={() => {
                openAttachmentPicker("images");
                setOpen(false);
              }}
            />
          </OptionMenuSection>
          <OptionMenuSection title={appCopy.composer.responseMode}>
            <OptionMenuItem
              icon={<MessageSquarePlus size="md" />}
              label={appCopy.composer.normal}
              selected={!planMode}
              onClick={() => {
                handlePlanModeChange(false);
                setOpen(false);
              }}
            />
            {projectId ? (
              <OptionMenuItem
                icon={<ListChecks size="md" />}
                label={appCopy.composer.plan}
                selected={planMode}
                onClick={() => {
                  handlePlanModeChange(true);
                  setOpen(false);
                }}
              />
            ) : null}
          </OptionMenuSection>
        </OptionMenu>
      </PopoverContent>
    </Popover>
  );
}
