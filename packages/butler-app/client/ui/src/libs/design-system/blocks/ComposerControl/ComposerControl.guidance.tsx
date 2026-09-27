import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Select, SelectContent, SelectItem, SelectValue } from "../../components/Select";
import { GitBranch, ShieldCheck } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ComposerControl, ComposerSelectControl } from "./index";

// #region recipe: Toolbar controls
function ToolbarControls() {
  return (
    <Stack align="row" gap="sm" wrap>
      <ComposerControl icon={<ShieldCheck size="md" />} label="Ask" />
      <Select defaultValue="worktree">
        <ComposerSelectControl aria-label="Workspace" icon={<GitBranch size="sm" />}><SelectValue /></ComposerSelectControl>
        <SelectContent position="popper" side="top">
          <SelectItem value="local">Local</SelectItem>
          <SelectItem value="worktree">Worktree</SelectItem>
        </SelectContent>
      </Select>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The composer toolbar control: icon, label and optional detail on a pill, or a Select trigger (ComposerSelectControl).",
  whenToUse: ["A composer setting that opens a menu (access, model, workspace)"],
  whenNotToUse: [
    { when: "A plain chip action", use: "PillButton" },
    { when: "A form select outside the composer", use: "Select" },
  ],
  recipes: [{ name: "Toolbar controls", description: "compact=\"icon\" hides the label on narrow widths; tone=\"danger\" flags errors.", render: () => <ToolbarControls /> }],
  doDont: [
    {
      do: { caption: "Composer controls keep their button height inside the toolbar.", render: () => <ToolbarControls /> },
      dont: { caption: "Regular buttons in the composer toolbar break its rhythm.", render: () => <Button size="sm" variant="outline" text="Ask" /> },
    },
  ],
  content: ["permissionTone (full, ask, read) colors an access-mode control and its icon.", "Label is the current value (Ask, GPT-5.1); detail adds one qualifier (medium)."],
  accessibility: ["Give the full value in aria-label when compact hides text; hit targets extend to 44px on touch."],
  tokens: ["--control-height-sm", "--radius-pill", "--composer-glass-control-bg", "--danger"],
};
