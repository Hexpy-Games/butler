import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { FileText, MessageSquare } from "../Icons";
import { Typo } from "../Typo";
import { InlineReference } from "./InlineReference";

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

export const guidance: ShowcaseGuidance = {
  purpose: "A conversation or document mention inside running text, with its icon, that opens the target.",
  whenToUse: ["Mention a conversation or document inside a message or summary"],
  whenNotToUse: [
    { when: "A standalone link-like action", use: "Button" },
    { when: "A document in a list", use: "DocumentTile" },
  ],
  recipes: [{ name: "References in a sentence", description: "It flows with text; unavailable references stay but dim.", render: () => <ReferencesInText /> }],
  doDont: [
    {
      do: { caption: "References sit inline and keep the sentence readable.", render: () => <ReferencesInText /> },
      dont: { caption: "Buttons inside a sentence break the line and the rhythm.", render: () => <Typo.Body as="p">Compare <Button size="xs" variant="outline" text="Insurance comparison" /> later.</Typo.Body> },
    },
  ],
  content: ["Use the target's title verbatim."],
  accessibility: ["It is a button with the title as its name; unavailable ones are not focusable."],
  tokens: ["--text-primary", "--selection", "--icon-size-sm"],
};
