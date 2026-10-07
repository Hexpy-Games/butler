import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Typo } from "../../components/Typo";
import { WallpaperStage } from "./WallpaperStage";

// #region recipe: Centered opaque card
function ContentStage() {
  return <WallpaperStage wallpaper={null}><Box surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg"><Typo.Body>Content above wallpaper</Typo.Body></Box></WallpaperStage>;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Center content above a Wallpaper on the viewport's base surface.",
  whenToUse: ["A small desktop lifecycle viewport"],
  whenNotToUse: [{ when: "A first-run wizard", use: "SetupWizardShell" }],
  recipes: [{ name: "Centered opaque card", description: "The containing viewport supplies the size; the stage owns stacking and the inset.", render: () => <ContentStage /> }],
  doDont: [{ do: { caption: "Keep text on an opaque card above the decorative backdrop.", render: () => <ContentStage /> },
    dont: { caption: "Avoid text directly on art without a content surface.", render: () => <Typo.Body>Text on art</Typo.Body> } }],
  content: ["Children own localized copy; the backdrop is decorative."],
  accessibility: ["Keep actions in no-drag ButtonContainer."], tokens: ["--space-lg", "--z-content"],
};
