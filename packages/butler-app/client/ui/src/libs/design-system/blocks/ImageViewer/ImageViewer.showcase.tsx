import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Copy, Library, Popup } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { BROKEN_IMAGE, VIEWER_LABELS, viewerImages } from "./fixtures";
import { ImageViewer } from "./ImageViewer";
import { ImageViewerSurface } from "./ImageViewerSurface";

export const meta: ShowcaseMeta = {
  title: "ImageViewer",
  category: "Documents & Artifacts",
  tags: ["image", "lightbox", "viewer", "picture", "gallery", "overlay", "provenance"],
  status: "beta",
};

type Locale = ShowcaseRenderContext["locale"];

function actions(locale: Locale) {
  const labels = VIEWER_LABELS[locale];
  return (
    <>
      <IconButton label={labels.open}><Popup size="sm" /></IconButton>
      <IconButton label={labels.save}><Library size="sm" /></IconButton>
      <IconButton label={labels.copy}><Copy size="sm" /></IconButton>
    </>
  );
}

/** The surface inside a fixed frame: what the modal shows, without the window overlay. */
function Contained({ locale, index = 0, broken = false }: { locale: Locale; index?: number; broken?: boolean }) {
  const images = broken ? [BROKEN_IMAGE] : viewerImages(locale);
  return (
    <ImageViewerSurface contained image={images[index]!} index={index} total={images.length} labels={VIEWER_LABELS[locale]}
        actions={actions(locale)} onPrevious={index > 0 ? () => undefined : undefined}
        onNext={index < images.length - 1 ? () => undefined : undefined} onClose={() => undefined} />
  );
}

/** The real modal: open it, page with the arrow keys, close with Esc or a click on the scrim. */
function Live({ locale }: { locale: Locale }) {
  const [index, setIndex] = useState<number | null>(null);
  const images = viewerImages(locale);
  return (
    <>
      <Button variant="outline" text={VIEWER_LABELS[locale].view} onClick={() => setIndex(0)} />
      <ImageViewer images={images} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)}
        labels={VIEWER_LABELS[locale]} actions={actions(locale)} />
    </>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Open the viewer", widths: ["375", "app", "wide"], render: ({ locale }) => <Live locale={locale} /> },
  { name: "First of three: caption and source", widths: ["375", "app", "wide"], render: ({ locale }) => <Contained locale={locale} /> },
  { name: "Last of three: no caption", widths: ["375", "app"], render: ({ locale }) => <Contained locale={locale} index={2} /> },
  { name: "A picture that cannot load", widths: ["375", "app"], render: ({ locale }) => <Contained locale={locale} broken /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  render: ({ locale }) => <Contained locale={locale} index={1} />,
};
