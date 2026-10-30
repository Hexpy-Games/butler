import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { ListRow } from "../ListRow";
import { AttachmentList } from "./AttachmentList";

// #region recipe: Removable composer attachments
function ComposerAttachments() {
  return (
    <AttachmentList variant="chips" onRemove={() => undefined} items={[
      { id: "notes", name: "project-notes.md", meta: "4 KB", icon: <FileText size="sm" /> },
      { id: "export", name: "large-export.json", meta: "2 MB" },
    ]} />
  );
}
// #endregion

// #region recipe: Sent files as tiles that open in the app
function MessageTiles({ open }: { open: (id: string) => void }) {
  return (
    <AttachmentList variant="tiles" tileLayout="wrap" onOpen={(item) => open(item.id)} items={[
      { id: "photo", name: "lake.jpg", meta: "2.4 MB", thumbnail: { src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'%3E%3Crect width='4' height='3' fill='%237fa9c4'/%3E%3C/svg%3E" } },
      { id: "report", name: "q2-report.pdf", meta: "1.1 MB", extension: "PDF" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Files attached to a message: square tiles (composer row, sent message), a list with sizes, or removable chips.",
  whenToUse: ["Files the user attached (composer tiles) or sent (message tiles)", "Picked page elements in the composer (chips)"],
  whenNotToUse: [
    { when: "Files Butler produced", use: "ArtifactList" },
    { when: "Project documents", use: "DocumentTile" },
  ],
  recipes: [
    { name: "Removable composer attachments", description: "variant=\"chips\" wraps and truncates long names; onRemove adds remove buttons.", render: () => <ComposerAttachments /> },
    { name: "Sent files as tiles that open in the app", description: "variant=\"tiles\" tileLayout=\"wrap\": 96px faces; onOpen makes each tile a button (the viewer or the inspector), never a link.", render: () => <MessageTiles open={() => undefined} /> },
  ],
  doDont: [
    {
      do: { caption: "Chips with size and a remove button.", render: () => <ComposerAttachments /> },
      dont: { caption: "List rows for pending attachments take too much composer space.", render: () => <ListRow icon={<FileText size="md" />} title="project-notes.md" meta="4 KB" /> },
    },
  ],
  content: [
    "tiles: a picture is a cover thumbnail (lazy, async decoded, fades in); a video (video.src) shows its first frame from metadata only, a play badge and its length; any other file shows its glyph, extension (the container passes a localized label for an unknown type), name (one line with an ellipsis; the tooltip shows it whole) and, on wrap tiles, its size. A broken picture falls back to the file face and calls onMediaError(item); a new src (a re-signed URL) loads again.",
    "tileLayout=\"row\" is the composer: 64px tiles in one row that scrolls sideways under the shared edge fade; a new tile grows in, a removed one shrinks out and the rest slide into the gap. tileLayout=\"wrap\" is a sent message: 96px tiles, end-aligned and wrapping; every file shows. tileAlign=\"start\" aligns wrap tiles to the start (a document or a detail pane).",
    "upload marks a file still uploading or failed: uploading (Spinner, aria-busy) or failed (alert icon, danger border); meta says how far or what to do (Uploading 40%, Over 10 MB). Clear it once the upload ends.",
    "onOpen opens the item inside the app (the image viewer over the conversation, or the inspector); with it the name or tile is a button and href is unused. Without onOpen a href stays a link.",
    "removeLabel is a word (the name is appended) or a function that returns the whole label for a name.",
    "windowDrag=\"no-drag\" keeps chips removable inside a drag region.",
    "Items with element (picked page elements) render as ElementChip: crop, title and site, leading the list in one wrapping row; removeLabel names their remove button.",
    "Show the file name as uploaded and a human size (4 KB).",
    "blockedReason keeps a chip the current model cannot take, dims it, and puts a few-word reason in its tooltip; the chip stays removable.",
    "An unknown capability is treated as unavailable (the gateway refuses it), with its own few-word reason (Image support unknown for this model).",
    "Capability feedback is terse and non-intrusive: the disabled state plus a few-word tooltip (disabledReason), at most a brief transient toast for a refused drop or paste; no banners, inline paragraphs, persistent notices, or why/how explanations.",
  ],
  accessibility: [
    "Remove buttons are labelled with the file name; image thumbnails need alt text.",
    "A tile is one button named by the file (and its blocked reason, or its meta while it is uploading or failed); its ✕ is a separate button, shown on hover and focus and always on touch.",
  ],
  tokens: ["--radius-pill", "--line", "--icon-size-sm", "--radius-panel", "--focus-ring-room", "--motion-scale-press", "--motion-scale-dialog", "--danger"],
};
