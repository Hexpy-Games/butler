import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import {
  IconButton,
  OptionMenu,
  OptionMenuItem,
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
          label={appCopy.composer.attachFile}
          disabled={uploadingCount > 0}
        >
          <Plus size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={themeClass}
        data-menu-size="content"
        side="top"
        sideOffset={10}
      >
        <OptionMenu title="첨부" size="fit">
          {projectId ? (
            <ComposerProjectDocumentMenu
              className={themeClass}
              projectId={projectId}
              onClose={() => setOpen(false)}
            />
          ) : null}
          <OptionMenuItem
            icon={<Paperclip size={15} />}
            label="파일 첨부"
            onClick={() => {
              openAttachmentPicker();
              setOpen(false);
            }}
          />
        </OptionMenu>
      </PopoverContent>
    </Popover>
  );
}
