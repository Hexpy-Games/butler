import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import { showcaseImageLoader } from "../Wallpaper/Wallpaper.demo";
import { INHERIT_LABEL, PICKER_LABELS } from "./WallpaperPicker.demo";
import { WallpaperPicker, type WallpaperPickerValue } from "./index";

// #region recipe: Settings wallpaper
// The container owns storage: it uploads, imports, selects the new image or module, and deletes; the picker only reports choices.
function SettingsWallpaper() {
  const [value, setValue] = useState<WallpaperPickerValue>({ kind: "live", module: "butler.bloom" });
  return (
    <WallpaperPicker imageLoader={showcaseImageLoader} images={[{ id: "landscape", luminance: 0.55 }]} labels={PICKER_LABELS["en-US"]}
      locale="en-US" value={value} onChange={setValue} onDeleteImage={() => undefined} onDeleteModule={() => undefined}
      onImportModule={() => undefined} onUpload={() => undefined} />
  );
}
// #endregion

// #region recipe: Project wallpaper that can inherit
function ProjectWallpaper() {
  const [value, setValue] = useState<WallpaperPickerValue>("inherit");
  return (
    <WallpaperPicker inherit={{ label: INHERIT_LABEL["en-US"], source: { kind: "live", module: "butler.silk" } }}
      labels={PICKER_LABELS["en-US"]} locale="en-US" value={value} onChange={setValue} />
  );
}
// #endregion

function Note({ text }: { text: string }) {
  return <Card><Typo.Body>{text}</Typo.Body></Card>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "Chooses a wallpaper: still thumbnails of none, every live module (the user's own last) and the uploaded images, an import-module and an upload tile, and the selected choice's controls generated from its manifest (images: fit, dim, blur, filter).",
  whenToUse: [
    "The Home screen wallpaper setting",
    "A project's wallpaper, with an inherit tile that follows the global one",
    "Any place a WallpaperSource is chosen by the user",
  ],
  whenNotToUse: [
    { when: "Drawing the chosen wallpaper", use: "Wallpaper" },
    { when: "Choosing between a few text options", use: "SegmentedControl" },
  ],
  recipes: [
    { name: "Settings wallpaper", description: "Controlled value; onUpload/onDeleteImage and onImportModule/onDeleteModule go to the container, which owns the image and module stores.", render: () => <SettingsWallpaper /> },
    { name: "Project wallpaper that can inherit", description: "inherit adds a first tile whose value is \"inherit\"; its source is previewed.", render: () => <ProjectWallpaper /> },
  ],
  doDont: [
    {
      do: { caption: "Upload, then select the new image with a dim from its luminance (wallpaperImageDefaultDim).", render: () => <Note text="onUpload → store → onChange({ kind: 'image', asset, fit: 'cover', dim, blur: 0 })" /> },
      dont: { caption: "Show a banner explaining upload limits; reject with a brief toast instead.", render: () => <Note text="JPEG, PNG or WebP up to 25 MB is required to upload an image here." /> },
    },
  ],
  content: [
    "Captions are short nouns: module names come from wallpaper.json, images are numbered.",
    "Errors (type, size, image in use) are the container's brief toasts, never text inside the picker.",
    "User modules (userModules, or the WallpaperRegistryProvider's) follow the built-ins with a subtle labels.mine marker; one that cannot be used is a disabled tile whose tooltip is the first line of its error.",
    "The import-module tile sits with the upload tile, after every option; onImportModule(file) receives a chosen .zip, and the container installs it, then selects the new module.",
  ],
  accessibility: [
    "The tiles are a radiogroup: one tab stop, arrow keys move and select (skipping tiles that cannot be chosen), Home and End jump.",
    "A module that cannot be used is aria-disabled, not disabled, so hover and focus still open its tooltip.",
    "Thumbnails are decorative; every tile is named by its caption, the delete button by its label.",
    "The upload and import-module tiles are buttons (file choosers); dropping files anywhere on the picker also uploads images.",
    "The selected image or module cannot be deleted here; it is in use.",
    "A user module that cannot be used still gets a delete button: it can be removed even while it cannot be chosen.",
  ],
  tokens: ["--radius-control", "--focus-ring", "--text-primary", "--selection", "--motion-fast"],
};
