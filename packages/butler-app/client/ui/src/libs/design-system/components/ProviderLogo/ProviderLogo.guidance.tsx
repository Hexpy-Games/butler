import type { ShowcaseGuidance } from "../../showcase";
import { Sparkles } from "../Icons";
import { IconTile } from "../IconTile";
import { Inline } from "../Inline";
import { Typo } from "../Typo";
import { ProviderLogo } from "./ProviderLogo";

// #region recipe: Logo beside a service name
function ServiceName() {
  return (
    <Inline gap="sm">
      <IconTile size="sm"><ProviderLogo name="claude" /></IconTile>
      <Typo.Label as="span">Claude</Typo.Label>
    </Inline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The logo of an AI service or local model server, drawn from vendored SVG files exactly as shipped.",
  whenToUse: ["A service logo on a choice card, model row or connection list"],
  whenNotToUse: [
    { when: "A generic action or status glyph", use: "Icons" },
    { when: "A glyph that must keep its column width in a row", use: "IconSlot" },
  ],
  recipes: [{ name: "Logo beside a service name", description: "The visible name carries the meaning, so the logo stays decorative.", render: () => <ServiceName /> }],
  doDont: [
    {
      do: { caption: "Use the service's own logo, unchanged.", render: () => <ServiceName /> },
      dont: { caption: "Do not stand in a generic icon (or a recolored logo) for a brand.", render: () => <Inline gap="sm"><Sparkles size="md" /><Typo.Label as="span">Claude</Typo.Label></Inline> },
    },
  ],
  content: [
    "Logos are their owners' trademarks; use them only to name the service a person connects to.",
    "Never recolor, stretch or crop a logo; add a new logo by vendoring its SVG file and listing it in logos/NOTICE.",
  ],
  accessibility: ["Decorative by default (aria-hidden). Pass label when no visible text names the service; it becomes role=img."],
  tokens: ["--icon-size-sm", "--icon-size-md", "--icon-size-lg", "--text-primary"],
};
