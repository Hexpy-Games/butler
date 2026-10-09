import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { Lock } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import { AddressField } from "./AddressField";

// #region recipe: Toolbar address
function ToolbarAddress() {
  return (
    <AddressField url="https://console.example.net/billing/invoices" onSubmit={() => undefined} bookmarked onToggleBookmark={() => undefined}
      tags={<Tag size="sm" tone="accent" icon={<Lock size="xs" />}>Signed in</Tag>} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The browser toolbar's address: security glyph, bold host with a muted path, tags and the star; a click edits the full URL.",
  whenToUse: ["The address in BrowserToolbar", "A Butler page's name in the same place (library, new tab)"],
  whenNotToUse: [
    { when: "A plain URL setting in a form", use: "Input" },
    { when: "A link inside text", use: "InlineReference" },
  ],
  recipes: [{ name: "Toolbar address", description: "Host first, the path muted; tags before the star.", render: () => <ToolbarAddress /> }],
  doDont: [
    {
      do: { caption: "Show the host; the full URL appears only while editing.", render: () => <ToolbarAddress /> },
      dont: { caption: "A raw input with the full URL hides the host behind the scheme and path.", render: () => <Input aria-label="Address" defaultValue="https://console.example.net/billing/invoices" /> },
    },
  ],
  content: ["Placeholder: Search or enter URL / 검색 또는 URL 입력.", "Tags are one or two words: Signed in / 로그인 사용, Butler output / 버틀러 출력물."],
  accessibility: [
    "At rest it is a button named “Address: <url>”; Enter or Space edits. In edit mode the input is labelled, Enter submits, Escape and blur cancel.",
    "The whole field shows the focus ring while editing; the lock and warning glyphs carry their own names.",
  ],
  tokens: ["--control-height-md", "--selection", "--focus-ring", "--radius-control", "--placeholder"],
};
