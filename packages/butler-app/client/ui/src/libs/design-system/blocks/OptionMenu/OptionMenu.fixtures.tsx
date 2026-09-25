import type { CSSProperties } from "react";
import {
  ChevronRight,
  Eye,
  FileText,
  ListChecks,
  MessageSquarePlus,
  Paperclip,
  ShieldCheck,
  ShieldQuestion,
} from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "./OptionMenu";

/** Mirrors the product menus: the composer + menu and the access-mode menu. */
export function OptionMenuFixture() {
  return (
    <Inline gap="2xl" cross="start" wrap>
      <OptionMenu title="Add to message" size="fit">
        <OptionMenuSection title="Attachments">
          <OptionMenuItem
            icon={<FileText size="md" />}
            label="Project documents"
            description={<ChevronRight size="sm" />}
          />
          <OptionMenuItem icon={<Paperclip size="md" />} label="Attach file" />
        </OptionMenuSection>
        <OptionMenuSection title="Response mode">
          <OptionMenuItem selected icon={<MessageSquarePlus size="md" />} label="Normal" />
          <OptionMenuItem icon={<ListChecks size="md" />} label="Plan" />
        </OptionMenuSection>
      </OptionMenu>
      <OptionMenu title="Permission">
        <OptionMenuItem
          selected
          icon={<ShieldCheck size="md" />}
          tone="warning"
          label="Full access"
          description="Can read files, write files, and run commands"
          descriptionPlacement="block"
        />
        <OptionMenuItem
          icon={<ShieldQuestion size="md" />}
          tone="accent"
          label="Ask first"
          description="Ask before changing files or running commands"
          descriptionPlacement="block"
        />
        <OptionMenuItem
          icon={<Eye size="md" />}
          label="Read only"
          description="Can only read files"
          descriptionPlacement="block"
          style={{ "--option-menu-icon-color": "var(--access-read-icon)" } as CSSProperties}
        />
      </OptionMenu>
    </Inline>
  );
}
