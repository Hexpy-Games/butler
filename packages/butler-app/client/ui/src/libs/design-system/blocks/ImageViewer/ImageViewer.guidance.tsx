import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Copy, Library, Popup } from "../../components/Icons";
import { DoneIconButton } from "../../components/DoneIconButton";
import { IconButton } from "../../components/IconButton";
import { MediaFrame } from "../../components/MediaFrame";
import { fixturePicture } from "../../components/MediaFrame/fixtures";
import { ItemCard } from "../ItemCard";
import { fixtureSave } from "../ItemCard/fixtures";
import { VIEWER_LABELS, viewerImages } from "./fixtures";
import { ImageViewer } from "./ImageViewer";
import { ImageViewerSurface } from "./ImageViewerSurface";

// #region recipe: A card picture opens the viewer
function CardPictureViewer() {
  const images = viewerImages("en-US");
  const [index, setIndex] = useState<number | null>(null);
  return (
    <>
      <ItemCard title="Gooseneck pour-over kettle" media={<MediaFrame aspect="1:1" fit="cover" src={images[0]!.src} alt="" />}
        onOpen={() => undefined} onMediaOpen={() => setIndex(0)} mediaLabel="View photo: Gooseneck pour-over kettle" />
      <ImageViewer images={images} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)} labels={VIEWER_LABELS["en-US"]}
        actions={<>
          <IconButton label="Open the source page"><Popup size="sm" /></IconButton>
          <DoneIconButton icon={<Library size="sm" />} label="Save to library" doneLabel="Saved to library" onAction={fixtureSave} />
          <IconButton label="Copy image"><Copy size="sm" /></IconButton>
        </>} />
    </>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Shows one picture of a set large on a blurred scrim in the theme's surface tone (a lightbox): previous/next through the set, its caption and source, and the container's actions.",
  whenToUse: ["A picture in a message, an answer card or gallery, or an activity screenshot the user wants to see large",
    "Paging through the pictures of one message or one block"],
  whenNotToUse: [
    { when: "A file or document preview inside a panel", use: "ArtifactPreview" },
    { when: "A form or a decision in a modal", use: "Dialog" },
  ],
  recipes: [{ name: "A card picture opens the viewer", description: "The card opens the item's page; its picture opens the viewer on the set.", render: () => <CardPictureViewer /> }],
  doDont: [
    {
      do: { caption: "Pass the set the picture belongs to and its index, so previous/next walks that set.",
        render: () => <ImageViewerSurface contained image={viewerImages("en-US")[0]!} index={0} total={3} labels={VIEWER_LABELS["en-US"]} onNext={() => undefined} onClose={() => undefined} /> },
      dont: { caption: "Do not open a picture by itself in a bare Dialog or a new window.",
        render: () => <MediaFrame aspect="1:1" src={fixturePicture("recipe")} /> },
    },
  ],
  content: [
    "alt names the picture for assistive tech; caption is the visible line (a title or the alt text). Keep both plain.",
    "source is where the picture was read: the site and the read time (“shop.example.com · 오후 5:41 확인”).",
    "Actions are IconButtons the container builds for the shown picture: open its page, save (a DoneIconButton that confirms), copy. Close is built in.",
    "kind: \"video\" plays an attached video on the stage with native controls; it never autoplays and preloads metadata only. Videos do not zoom.",
    "zoomIn / zoomOut labels are one or two words (Zoom in / 확대, Zoom out / 축소).",
  ],
  accessibility: [
    "A modal dialog: focus moves to Close, stays inside and returns to the opener. Esc and a click on the scrim close.",
    "Left and right arrows page the set; the position (“2 / 5”) is the dialog description and is announced.",
    "Pictures open fitted. Double-click or double-tap zooms to 2x at the point (again: back to fit); pinch and ctrl/cmd + wheel zoom around the fingers or cursor up to 4x; a drag pans while zoomed. +, - and 0 zoom from the keyboard; zoomIn/zoomOut labels add buttons beside the actions.",
    "Reduced motion keeps only the fade.",
  ],
  tokens: ["--image-viewer-overlay-bg", "--image-viewer-overlay-filter", "--shadow-card", "--z-dialog", "--radius-control", "--space-3", "--motion-base", "--motion-scale-dialog"],
};
