import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { FolderPlus, Settings } from "./Icons";

// #region recipe: Icon in a button
function NewProjectButton() {
  return <Button variant="outline" iconStart={<FolderPlus size="md" />} text="New project" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The Hugeicons set mapped to Butler names, sized by the icon token scale.",
  whenToUse: ["Support a label with a glyph", "Mark row types in lists and navigation"],
  whenNotToUse: [
    { when: "An icon that is the whole control", use: "IconButton" },
    { when: "A status word that needs color", use: "Tag" },
  ],
  recipes: [{ name: "Icon in a button", description: "Pass icons through iconStart/iconEnd; size=\"md\" in default controls.", render: () => <NewProjectButton /> }],
  doDont: [
    {
      do: { caption: "Use the token sizes (xs…2xl).", render: () => <Settings size="md" /> },
      dont: { caption: "Pixel sizes drift from the 12/14/16/20/24/32 scale.", render: () => <Stack align="row" gap="xs"><Settings size={17} /><Typo.Caption>17px</Typo.Caption></Stack> },
    },
  ],
  content: ["Name new mappings after the meaning (FolderPlus), not the glyph file."],
  accessibility: ["Icons are decorative (aria-hidden); the surrounding label carries the meaning."],
  tokens: ["--icon-size-sm", "--icon-size-md", "--icon-size-lg"],
};
