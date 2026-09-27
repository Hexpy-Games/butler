import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { ActivityStrip } from "./ActivityStrip";

const DAYS = ["Sep 20", "Sep 21", "Sep 22", "Sep 23", "Sep 24", "Sep 25", "Sep 26"];

// #region recipe: Changed days under a row
function ChangedDays() {
  const days = DAYS.map((label, index) => ({ key: label, label, active: index % 3 === 0 }));
  return <ActivityStrip days={days} ariaLabel={days.filter((day) => day.active).map((day) => day.label).join(", ")} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A thin strip with one cell per day, filled on the days something changed.",
  whenToUse: ["Show when a document or source changed over a short window, under a list row"],
  whenNotToUse: [
    { when: "Weeks of activity in a calendar grid", use: "ActivityHeatmap" },
    { when: "A share of a total", use: "ProgressMeter" },
  ],
  recipes: [{ name: "Changed days under a row", description: "Each cell titles its date; ariaLabel speaks the active dates.", render: () => <ChangedDays /> }],
  doDont: [
    {
      do: { caption: "Cells keep the window readable at a glance.", render: () => <ChangedDays /> },
      dont: { caption: "A list of dates is hard to scan.", render: () => <Typo.Caption>Sep 20, Sep 23, Sep 26</Typo.Caption> },
    },
  ],
  content: ["Titles use short localized dates."],
  accessibility: ["The strip is one image with an aria-label listing the active dates."],
  tokens: ["--line", "--context-chart-1", "--space-sm"],
};
