import type { ShowcaseGuidance } from "../../showcase";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/DropdownMenu";
import { Button } from "../../components/Button";
import { ListChecks, MessageSquarePlus, Paperclip } from "../../components/Icons";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "./OptionMenu";

// #region recipe: Composer add menu
function AddMenu() {
  return (
    <OptionMenu title="Add to message" size="fit">
      <OptionMenuSection title="Attachments">
        <OptionMenuItem icon={<Paperclip size="md" />} label="Attach file" />
      </OptionMenuSection>
      <OptionMenuSection title="Response mode">
        <OptionMenuItem selected icon={<MessageSquarePlus size="md" />} label="Normal" />
        <OptionMenuItem icon={<ListChecks size="md" />} label="Plan" />
      </OptionMenuSection>
    </OptionMenu>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A compact chooser surface (inside a Popover) with flat sections, icons, descriptions and a selected mark.",
  whenToUse: ["Choose a mode or permission from the composer", "A small menu that mixes actions and a current choice"],
  whenNotToUse: [
    { when: "Actions for an item", use: "DropdownMenu" },
    { when: "Search across many options", use: "FilteredSelectPopover" },
  ],
  recipes: [{ name: "Composer add menu", description: "Sections stay flat: titles and items share one left edge.", render: () => <AddMenu /> }],
  doDont: [
    {
      do: { caption: "A selected mark shows the current mode.", render: () => <AddMenu /> },
      dont: {
        caption: "A dropdown menu cannot show which mode is current.",
        render: () => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" text="Mode" /></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Normal</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    },
  ],
  content: [
    "permissionTone (full, ask, read) colors access-mode items and their icons.",
    "Title names the choice; descriptions explain consequences in one line.",
    "disabledReason disables an unavailable item and names why in a tooltip of a few words (Model doesn't accept images).",
    "Capability feedback is terse and non-intrusive: the disabled state plus a few-word tooltip (disabledReason), at most a brief transient toast for a refused drop or paste; no banners, inline paragraphs, persistent notices, or why/how explanations.",
  ],
  accessibility: [
    "Items are buttons; selected items expose aria-pressed; tones never carry meaning alone.",
    "A disabledReason item is aria-disabled, not disabled, so hover and keyboard focus still open its tooltip.",
  ],
  tokens: ["--menu-item-height", "--menu-group-label-size", "--access-full", "--access-ask", "--access-read-icon"],
};
