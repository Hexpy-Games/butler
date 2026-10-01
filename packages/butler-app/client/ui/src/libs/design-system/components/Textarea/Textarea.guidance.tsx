import type { ShowcaseGuidance } from "../../showcase";
import { Field, FieldDescription, FieldLabel } from "../Field";
import { Input } from "../Input";
import { Textarea } from "./Textarea";

// #region recipe: Persona field
function PersonaField() {
  return (
    <Field>
      <FieldLabel htmlFor="persona">Persona</FieldLabel>
      <Textarea id="persona" defaultValue="Direct and calm. Ask before destructive changes." />
      <FieldDescription>How Butler presents itself and works with you.</FieldDescription>
    </Field>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A multi-line text box for prompts, personas, arguments and descriptions.",
  whenToUse: ["Enter a paragraph or a list with one item per line", "In-place wrapping entry: variant=underline, textSize=label beside Typo.Label"],
  whenNotToUse: [
    { when: "A single-line value", use: "Input" },
    { when: "Writing a chat message", use: "ComposerCard" },
  ],
  recipes: [{ name: "Persona field", description: "A labelled Textarea with a one-line description.", render: () => <PersonaField /> }],
  doDont: [
    {
      do: { caption: "Use Textarea for text that wraps over lines.", render: () => <PersonaField /> },
      dont: { caption: "Long text squeezed into an Input scrolls sideways and hides content.", render: () => <Input aria-label="Persona" defaultValue="Direct and calm. Ask before destructive changes and explain trade-offs." /> },
    },
  ],
  content: ["Say the expected format in the description (One per line)."],
  accessibility: ["Resizes vertically only; keep a visible label; maxLength needs a visible count when it matters."],
  tokens: ["--line", "--radius-control", "--placeholder", "--focus-ring", "--focus-ring-width", "--textarea-max-lines", "--scroll-fade-size"],
};
