import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Circle, Plus } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { EmptyLine } from "./EmptyLine";

// #region recipe: Empty list with a next step
function EmptyAutomations() {
  return <EmptyLine icon={<Circle size="md" />} message="No automations yet." action={<Button size="sm" variant="outline" iconStart={<Plus size="md" />} text="New automation" />} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A one-line empty state that says what is missing and offers the next step.",
  whenToUse: ["An empty list, panel or search result"],
  whenNotToUse: [
    { when: "Something failed", use: "Notice" },
    { when: "Content is loading", use: "Skeleton" },
    { when: "An empty new chat", use: "PromptSuggestionList" },
  ],
  recipes: [{ name: "Empty list with a next step", description: "Message plus one action when there is an obvious next step.", render: () => <EmptyAutomations /> }],
  doDont: [
    {
      do: { caption: "Say what is empty and how to fill it.", render: () => <EmptyAutomations /> },
      dont: { caption: "A bare Nothing here explains nothing.", render: () => <Typo.Caption tone="tertiary">Nothing here</Typo.Caption> },
    },
  ],
  content: ["No X yet. (아직 X가 없습니다.) — name the thing."],
  accessibility: ["Plain text; the action is a regular button."],
  tokens: ["--text-secondary", "--space-sm"],
};
