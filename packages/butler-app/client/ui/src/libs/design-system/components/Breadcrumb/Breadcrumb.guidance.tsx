import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./Breadcrumb";

// #region recipe: In-app settings trail
function SettingsTrail() {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem><BreadcrumbButton onClick={() => undefined}>Models</BreadcrumbButton></BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem><BreadcrumbPage>Add model</BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Shows where a nested page sits and lets people step back up the hierarchy.",
  whenToUse: ["A page two or more levels deep (settings detail, automation detail)"],
  whenNotToUse: [
    { when: "Switching sibling views", use: "Tabs" },
    { when: "A single back step", use: "IconButton" },
  ],
  recipes: [{ name: "In-app settings trail", description: "BreadcrumbButton for in-app steps (no URL); the current page is BreadcrumbPage.", render: () => <SettingsTrail /> }],
  doDont: [
    {
      do: { caption: "The last item is the current page and is not a link.", render: () => <SettingsTrail /> },
      dont: { caption: "Slash-separated text cannot be navigated or announced.", render: () => <Stack align="row"><Typo.Body>Models / Add model</Typo.Body></Stack> },
    },
  ],
  content: ["Use page titles exactly as they appear in navigation."],
  accessibility: ["nav landmark with aria-current=\"page\" on the last item; separators are hidden."],
  tokens: ["--text-secondary", "--text-primary", "--icon-size-sm"],
};
