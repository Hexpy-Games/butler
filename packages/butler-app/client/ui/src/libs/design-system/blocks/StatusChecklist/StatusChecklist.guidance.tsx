import type { ShowcaseGuidance } from "../../showcase";
import { CheckCard, CheckCardList } from "../CheckCard";
import { StatusChecklist } from "./StatusChecklist";

const ITEMS = [
  { text: "Book the venue", done: true },
  { text: "Send invitations", done: false },
];

// #region recipe: Steps Butler reports
function Steps() {
  return <StatusChecklist items={ITEMS} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A read-only list of items that are done or not, with CheckCard's round indicator: an answer, 서랍 or document checklist block.",
  whenToUse: ["Showing which steps or items are done", "A checklist inside an answer block, a 서랍 block scrap or a document"],
  whenNotToUse: [
    { when: "People pick items before an action", use: "CheckCard" },
    { when: "Live task progress of a running turn", use: "TodoProgressPanel" },
  ],
  recipes: [{ name: "Steps Butler reports", description: "Done items read in the secondary tone.", render: () => <Steps /> }],
  doDont: [
    {
      do: { caption: "Read-only status: a StatusChecklist.", render: () => <Steps /> },
      dont: {
        caption: "Toggle cards for status nobody can change.",
        render: () => <CheckCardList label="Steps">{ITEMS.map((item) => <CheckCard key={item.text} title={item.text} checked={item.done} onCheckedChange={() => undefined} />)}</CheckCardList>,
      },
    },
  ],
  content: ["One item per line of work; a few words each.", "Order items as the work runs, not by state."],
  accessibility: ["Each row is a read-only checkbox (`role=\"checkbox\"`, `aria-readonly`), so its state is read with its text."],
  tokens: ["--space-sm", "--typo-body-line-height", "--accent", "--line-strong"],
};
