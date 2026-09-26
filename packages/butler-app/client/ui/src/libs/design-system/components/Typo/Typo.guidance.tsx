import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { AppTitle, DashboardTitle, PanelSectionTitle, Typo } from "./index";

// #region recipe: App chrome titles
function ChromeTitles() {
  return (
    <Stack gap="sm">
      <AppTitle>Butler</AppTitle>
      <DashboardTitle>butler</DashboardTitle>
      <PanelSectionTitle>Branch details</PanelSectionTitle>
      <Typo.Caption tone="secondary">Compact roles keep chrome small; H1–H6 are for documents.</Typo.Caption>
    </Stack>
  );
}
// #endregion

// #region recipe: Truncated title with a clamp
function ClampedTitle() {
  return <Typo.Body lineClamp={2} wrap="anywhere">Move the settings pages to the section-header pattern and remove the duplicated card titles</Typo.Body>;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Every piece of text: document roles (H1–H6, Body, Caption, Label, Code) and compact app roles, all token-backed.",
  whenToUse: ["Any visible text in product UI", "Tone, weight, truncation and line clamps without CSS"],
  whenNotToUse: [
    { when: "A labelled form control", use: "FieldLabel" },
    { when: "Rendered markdown", use: "MarkdownContent" },
    { when: "A chat message body", use: "MessageRow" },
  ],
  recipes: [
    { name: "App chrome titles", description: "AppTitle, DashboardTitle and PanelSectionTitle are the compact chrome roles.", render: () => <ChromeTitles /> },
    { name: "Truncated title with a clamp", description: "lineClamp and wrap replace custom overflow CSS.", render: () => <ClampedTitle /> },
  ],
  doDont: [
    {
      do: { caption: "A panel title uses the compact PanelTitle role.", render: () => <Typo.PanelTitle>Context usage</Typo.PanelTitle> },
      dont: { caption: "Display headings in app chrome shout.", render: () => <Typo.H1>Context usage</Typo.H1> },
    },
  ],
  content: ["Body text is regular weight; bold is for titles, labels and metric values only."],
  accessibility: ["Headings (H1–H6) are real heading elements; pick them for the document outline, not for size."],
  tokens: ["--typo-body-size", "--typo-caption-size", "--typo-panel-title-size", "--font-weight-regular", "--font-weight-strong"],
};
