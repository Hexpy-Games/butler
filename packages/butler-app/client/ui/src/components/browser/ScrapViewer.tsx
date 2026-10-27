import { useEffect, useState } from "react";
import { create } from "zustand";
import { appCopy, useAppLocale } from "@/app/copy";
import { ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage, Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Typo, type DialogSize } from "@/butler-ds";
import { hasWebSource } from "../library/libraryActions";
import { librarySnapshot, type LibraryItem } from "./libraryStore";

/** The scrap open in the viewer; any surface that lists scraps opens it here. */
export const useScrapViewer = create<{ item?: LibraryItem }>(() => ({}));
export function openScrap(item: LibraryItem) { useScrapViewer.setState({ item }); }

// Dialog padding, preview padding and border around the clipped part.
const CHROME = 2 * 16 + 2 * 12 + 2;
const SIZES: Array<[DialogSize, number]> = [["sm", 380], ["md", 520], ["lg", 720], ["xl", 880]];
const dialogSize = (width: number): DialogSize => SIZES.find(([, max]) => width + CHROME <= max)?.[0] ?? "full";

/**
 * A scrap's HTML copy of exactly the clipped part, at its own size, in a sandboxed frame: no scripts, no same-origin
 * access, and the copy's own CSP admits only inline styles and data: images and fonts. Links open outside as popups.
 * A copy that cannot be read shows the scrap's crop.
 */
export function ScrapViewer({ onSource }: { onSource: (item: LibraryItem) => void }) {
  useAppLocale();
  const item = useScrapViewer(state => state.item);
  const [copy, setCopy] = useState<{ id: string; html: string | null }>();
  useEffect(() => {
    if (!item) return;
    let active = true;
    void librarySnapshot(item.id).then(html => { if (active) setCopy({ id: item.id, html }); }, () => { if (active) setCopy({ id: item.id, html: null }); });
    return () => { active = false; };
  }, [item]);
  const close = () => { useScrapViewer.setState({ item: undefined }); setCopy(undefined); };
  const size = item?.snapshot, loaded = copy && copy.id === item?.id ? copy : undefined;
  const text = appCopy.browser;
  return <Dialog open={Boolean(item)} onOpenChange={open => { if (!open) close(); }}>
    {item && <DialogContent size={dialogSize(size?.width ?? 0)} closeLabel={appCopy.common.close} data-test-class="scrap-viewer">
      <DialogHeader><DialogTitle>{item.title}</DialogTitle>{hasWebSource(item) && item.site && <DialogDescription>{item.site}</DialogDescription>}</DialogHeader>
      <ArtifactPreview>
        {loaded?.html && size ? <ArtifactPreviewFrame srcDoc={loaded.html} title={item.title} intrinsicSize={size}
          sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" data-test-class="scrap-frame" />
          : loaded && item.crop ? <ArtifactPreviewImage src={item.crop} alt={item.title} />
            : <Typo.Caption>{loaded ? text.failed : appCopy.artifacts.loading}</Typo.Caption>}
      </ArtifactPreview>
      {hasWebSource(item) && <DialogFooter><ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={() => { close(); onSource(item); }}>{text.openSourcePage}</Button>
      </ButtonContainer></DialogFooter>}
    </DialogContent>}
  </Dialog>;
}
