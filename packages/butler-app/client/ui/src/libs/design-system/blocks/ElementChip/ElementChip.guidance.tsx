import type { ShowcaseGuidance } from "../../showcase";
import { AttachmentList } from "../AttachmentList";

const CROP = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 60'%3E%3Crect width='60' height='60' fill='%23dfe4ea'/%3E%3Crect x='22' y='12' width='16' height='24' rx='4' fill='%23353a42'/%3E%3C/svg%3E";

// #region recipe: Picked elements in the composer
function ComposerElements() {
  return (
    <AttachmentList variant="chips" onRemove={() => undefined} items={[
      { id: "e1", name: "Mesh Office Chair M2", element: { site: "shop.example.com" }, thumbnail: { src: CROP } },
      { id: "e2", name: "Air Mesh Chair", element: { site: "shop.example.com" }, thumbnail: { src: CROP } },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A picked page element as an attachment chip: its crop, a short title and the site; removable in the composer, read-only in messages.",
  whenToUse: ["Elements picked in the browser and added to the chat", "The same chips inside the sent message"],
  whenNotToUse: [
    { when: "Files and images from disk", use: "AttachmentList" },
    { when: "A reference to a conversation or document in text", use: "InlineReference" },
  ],
  recipes: [{ name: "Picked elements in the composer", description: "Through AttachmentList: items with `element` render as ElementChip.", render: () => <ComposerElements /> }],
  doDont: [
    {
      do: { caption: "Pass items to AttachmentList; element chips lead in one wrapping row.", render: () => <ComposerElements /> },
      dont: { caption: "A bare image chip loses the title and the site.", render: () => <AttachmentList variant="chips" items={[{ id: "i", name: "pick-1.png", thumbnail: { src: CROP } }]} /> },
    },
  ],
  content: ["Title: the element's own words (a product name), a few words; the site is the host only."],
  accessibility: ["Remove reads “Remove: <title>”; the full title and site are in the tooltip when truncated.", "Without onRemove the chip has no controls (sent messages)."],
  tokens: ["--control-height-sm", "--radius-control", "--composer-glass-control-bg", "--text-tertiary"],
};
