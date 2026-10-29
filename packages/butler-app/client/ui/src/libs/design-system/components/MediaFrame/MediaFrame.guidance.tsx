import type { ShowcaseGuidance } from "../../showcase";
import { Grid } from "../Grid";
import { fixturePicture } from "./fixtures";
import { MediaFrame } from "./MediaFrame";

// #region recipe: Pictures in a row of cards
function PictureRow() {
  return (
    <Grid columns="3" gap="md">
      <MediaFrame aspect="4:5" src={fixturePicture("product")} />
      <MediaFrame aspect="4:5" src={fixturePicture("paper")} />
      <MediaFrame aspect="4:5" />
    </Grid>
  );
}
// #endregion

// #region recipe: One picture at its own size
function NaturalPicture() {
  return <MediaFrame src={fixturePicture("product")} natural={{ width: 120, height: 80 }} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A picture in a fixed-shape frame on the neutral matte: whole, never cropped, hidden until its shape is known, an empty matte when missing.",
  whenToUse: ["The picture slot of a card (ItemCard, LibraryCard)", "A gallery rail or thumbnail of a collected picture"],
  whenNotToUse: [
    { when: "A square canvas or animated mark", use: "AspectFrame" },
    { when: "A file or output preview with its own viewer", use: "ArtifactPreviewImage" },
  ],
  recipes: [
    { name: "Pictures in a row of cards", description: "One aspect per set, so a row lines up; a missing picture keeps its place.", render: () => <PictureRow /> },
    { name: "One picture at its own size", description: "natural: the picture's shape, at most its display width (pixels ÷ pixel ratio), shrinking to the container.", render: () => <NaturalPicture /> },
  ],
  doDont: [
    {
      do: { caption: "Pass pictures as they are; the frame letterboxes or insets them.", render: () => <MediaFrame aspect="16:10" src={fixturePicture("strip")} /> },
      dont: {
        caption: "Do not drop the frame for a missing picture; the row loses its rhythm.",
        render: () => <Grid columns="2" gap="md"><MediaFrame aspect="4:5" src={fixturePicture("product")} /><span /></Grid>,
      },
    },
  ],
  content: [
    "One aspect per set of pictures (a block of cards, a gallery). 4:5 suits objects and people, 1:1 logos and dishes, 3:4 pages, 16:10 and 16:9 views and places.",
    "Pass pictures as captured: never pre-crop, pad or tint them. Dark mode changes only the matte.",
    "A picture shown on its own (an image block) takes `natural` with its display size (pixel size ÷ pixel ratio, so a 2× screenshot is not shown twice as large): never upscaled, shrunk to the container, its shape reserved while it loads, aligned to the inline start.",
    "alt is the picture's own description; leave it empty when a title beside the frame names the item.",
    "Loading is built in: the matte holds the shape, the picture fades in once it loads and a failed one's placeholder fades in. Never add a spinner or a second placeholder.",
  ],
  accessibility: [
    "The frame has no role or click behavior; the owner makes it a target.",
    "alt defaults to empty (decorative); pass the picture's description when nothing beside it names the item.",
    "Reduced motion (the OS, the app's setting or reducedMotion): pictures and placeholders appear without a fade.",
  ],
  tokens: ["--muted", "--radius-control", "--space-md", "--line", "--browser-card-shadow", "--tag-height-sm", "--motion-slow", "--motion-ease-decelerate"],
};
