import type { ShowcaseGuidance } from "../../showcase";
import { ComposerControl } from "../../blocks/ComposerControl";
import { OptionMenu, OptionMenuItem } from "../../blocks/OptionMenu";
import { Button } from "../Button";
import { Eye, ShieldCheck } from "../Icons";
import { Tooltip } from "../Tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";

// #region recipe: Composer chooser popover
function AccessChooser() {
  return (
    <Popover>
      <PopoverTrigger asChild><ComposerControl icon={<ShieldCheck size="sm" />} label="Ask" /></PopoverTrigger>
      <PopoverContent align="start" data-menu-size="compact" side="top" sideOffset={10}>
        <OptionMenu title="Permission">
          <OptionMenuItem selected icon={<ShieldCheck size="md" />} label="Ask first" />
          <OptionMenuItem icon={<Eye size="md" />} label="Read only" />
        </OptionMenu>
      </PopoverContent>
    </Popover>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A non-modal glass layer anchored to a control, for choosers and small panels.",
  whenToUse: ["A chooser opened from a composer control", "A searchable select (with FilteredSelectPopover)"],
  whenNotToUse: [
    { when: "A plain list of actions", use: "DropdownMenu" },
    { when: "A task that needs focus and a backdrop", use: "Dialog" },
    { when: "A label that explains a control", use: "Tooltip" },
  ],
  recipes: [{ name: "Composer chooser popover", description: "side=\"top\" above the composer; the content is an OptionMenu.", render: () => <AccessChooser /> }],
  doDont: [
    {
      do: { caption: "Popovers hold interactive choices and close on selection.", render: () => <AccessChooser /> },
      dont: { caption: "A tooltip with buttons in it cannot be reached by keyboard.", render: () => <Tooltip label="Choose access"><Button variant="outline" text="Access" /></Tooltip> },
    },
  ],
  content: ["Portalled content takes theme={appShellTheme(settings)} so it renders in the app theme outside the shell.", "Titles name the choice (Permission, Model); items are short."],
  accessibility: ["Focus stays on the trigger unless content needs it; Escape and outside click close it."],
  tokens: ["--tinted-glass-bg", "--radius-popover", "--motion-enter-overlay", "--motion-scale-menu", "--z-popover"],
};
