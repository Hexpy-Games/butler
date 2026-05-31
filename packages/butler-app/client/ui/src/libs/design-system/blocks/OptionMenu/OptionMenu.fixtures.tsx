import type { CSSProperties } from "react";
import { Bot, Eye, ShieldCheck, ShieldQuestion, Sparkles } from "../../components/Icons";
import { Separator } from "../../components/Separator";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "./OptionMenu";

export function OptionMenuFixture() {
  return (
    <OptionMenu title="Model chooser">
      <OptionMenuSection title="Model">
        <OptionMenuItem
          selected
          icon={<Bot size={15} />}
          label="GPT-5.5"
          description="OpenAI / 1.05M API context"
        />
        <OptionMenuItem
          icon={<Sparkles size={15} />}
          label="Gemma 4 31B it"
          description="Local / 16k API context"
        />
      </OptionMenuSection>
      <Separator line />
      <OptionMenuSection title="Reasoning">
        <OptionMenuItem label="Instant" />
        <OptionMenuItem label="Medium" />
      </OptionMenuSection>
      <Separator line />
      <OptionMenuItem
        icon={<ShieldCheck size={15} />}
        tone="warning"
        label="Full access"
        description="Read, write, and run commands"
        descriptionPlacement="block"
      />
      <OptionMenuItem
        icon={<ShieldQuestion size={15} />}
        tone="accent"
        label="Ask first"
        description="Approval before edits"
        descriptionPlacement="block"
      />
      <OptionMenuItem
        icon={<Eye size={15} />}
        label="Read only"
        description="Read files only"
        descriptionPlacement="block"
        style={{
          "--option-menu-icon-color": "var(--access-read-icon)",
        } as CSSProperties}
      />
    </OptionMenu>
  );
}
