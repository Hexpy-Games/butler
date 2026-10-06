import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { FileText, MessageSquare } from "../Icons";
import { Typo } from "../Typo";
import { InlineReference } from "./InlineReference";
import { sampleFaviconSrc } from "./sampleFavicons";

// #region recipe: References in a sentence
function ReferencesInText() {
  return (
    <Typo.Body as="p">
      Compare <InlineReference icon={<MessageSquare />} onClick={() => undefined}>Insurance comparison</InlineReference>{" "}
      with <InlineReference icon={<FileText />} onClick={() => undefined}>Q3 plan notes</InlineReference>.
    </Typo.Body>
  );
}
// #endregion

// #region recipe: External links in a sentence
function ExternalLinksInText({ faviconSrc }: { faviconSrc?: (href: string) => string | undefined }) {
  const guide = "https://docs.example.com/guide/first-run/";
  const issue = "https://github.com/example-org/notes/issues/512";
  return (
    <Typo.Body as="p">
      Read the <InlineReference kind="external" href={guide} iconSrc={faviconSrc?.(guide)}>first-run guide</InlineReference>{" "}
      or follow <InlineReference kind="external" href={issue} iconSrc={faviconSrc?.(issue)} />.
    </Typo.Body>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A mention inside running text: a conversation or document (opens in the app) or an external URL (opens in the browser), with its icon.",
  whenToUse: [
    "Mention a conversation or document inside a message or summary",
    "An external http(s) link in a sentence, a reply, a caption or a settings description (kind=\"external\")",
    "A standalone link that leaves the app, such as \"Get a key\" or \"Learn more\" (kind=\"external\" inside Typo)",
  ],
  whenNotToUse: [
    { when: "An in-app action styled as a link (retry, copy link, show more)", use: "Button" },
    { when: "A call to action that leaves the app (Install Git in a notice)", use: "Button" },
    { when: "A URL the user reads or copies (server address, endpoint)", use: "Typo" },
    { when: "Markdown output", use: "MarkdownContent" },
    { when: "A document in a list", use: "DocumentTile" },
  ],
  recipes: [
    { name: "References in a sentence", description: "It flows with text; unavailable references stay but dim.", render: () => <ReferencesInText /> },
    { name: "External links in a sentence", description: "Pass a title, or none to show the domain; the full URL is in the tooltip. iconSrc comes from the app's favicon service.", render: () => <ExternalLinksInText faviconSrc={sampleFaviconSrc} /> },
  ],
  doDont: [
    {
      do: { caption: "References sit inline and keep the sentence readable.", render: () => <ReferencesInText /> },
      dont: { caption: "Buttons inside a sentence break the line and the rhythm.", render: () => <Typo.Body as="p">Compare <Button size="xs" variant="outline" text="Insurance comparison" /> later.</Typo.Body> },
    },
    {
      do: { caption: "A titled link or the domain, with the site's icon.", render: () => <ExternalLinksInText faviconSrc={sampleFaviconSrc} /> },
      dont: { caption: "A raw underlined URL runs past the line and hides where it goes.", render: () => <Typo.Body as="p" wrap="anywhere">Follow <a href="https://github.com/example-org/notes/issues/512">https://github.com/example-org/notes/issues/512</a>.</Typo.Body> },
    },
  ],
  content: [
    "Use the target's title verbatim.",
    "External: a descriptive title, never \"click here\"; a bare URL shows its domain. No \"↗\" or \"(link)\" suffix: the icon already says it leaves the app.",
  ],
  accessibility: [
    "A mention is a button with the title as its name; unavailable ones are not focusable.",
    "An external link is a real anchor (Tab, Enter) with the title as its name; the full URL is its description and tooltip. It opens in the system browser with noopener and no referrer.",
    "Icons are decorative; the favicon swap keeps the same box, so nothing moves.",
  ],
  tokens: ["--accent-text", "--text-primary", "--selection", "--icon-size-sm", "--favicon-plate", "--favicon-plate-line", "--focus-ring-color", "--motion-fast"],
};
