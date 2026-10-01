import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { Notice } from "./Notice";

// #region recipe: Load failure with retry
function LoadFailed() {
  return (
    <Notice tone="error" title="Could not load the dashboard" message="Check the connection and try again."
      action={<Button variant="outline" text="Retry" />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An inline status message (info, success, warning, error) with an optional title and action.",
  whenToUse: ["A failure or warning tied to one part of the screen", "A persistent status the user should notice"],
  whenNotToUse: [
    { when: "A transient confirmation", use: "Toaster" },
    { when: "An empty list", use: "EmptyLine" },
    { when: "A field error", use: "FieldError" },
  ],
  recipes: [{ name: "Load failure with retry", description: "Title says what failed; message says what to do; action retries.", render: () => <LoadFailed /> }],
  doDont: [
    {
      do: { caption: "Errors explain and offer the next step.", render: () => <LoadFailed /> },
      dont: { caption: "Red text alone is easy to miss and has no action.", render: () => <Typo.Body tone="danger">Error</Typo.Body> },
    },
  ],
  content: ["Multi-line messages use a body-sized IconSlot aligned to the first line; single-line messages retain their alignment.", "Titles are statements (Could not load the dashboard / 대시보드를 불러오지 못했습니다)."],
  accessibility: ["Tone is also conveyed by the title and icon, never by color alone."],
  tokens: ["--color-danger-bg", "--color-warning-bg", "--color-info-bg", "--color-success-bg", "--radius-control", "--icon-size-md", "--typo-body-line-height"],
};
