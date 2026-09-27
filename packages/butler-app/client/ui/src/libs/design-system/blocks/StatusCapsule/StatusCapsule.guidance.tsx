import type { ShowcaseGuidance } from "../../showcase";
import { PillButton } from "../../components/PillButton";
import { Spinner } from "../../components/Spinner";
import { StatusCapsule } from "./StatusCapsule";

// #region recipe: Worker progress capsule
function WorkerCapsule() {
  return (
    <StatusCapsule icon={<Spinner />} title="Review the activity surface" detail="Validating the activity surface" progress="2/3"
      aria-label="Review the activity surface · Validating the activity surface · 2/3" onClick={() => undefined} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A glass pill that summarizes running work: title · detail · progress, each part truncating within its cap.",
  whenToUse: ["Background work the user can open from above the composer"],
  whenNotToUse: [
    { when: "A composer setting (model, access)", use: "ComposerControl" },
    { when: "A plain filter chip", use: "PillButton" },
  ],
  recipes: [{ name: "Worker progress capsule", description: "The aria-label repeats all parts; the title attribute keeps the full title.", render: () => <WorkerCapsule /> }],
  doDont: [
    {
      do: { caption: "Each part truncates on its own, so the step count stays visible.", render: () => <WorkerCapsule /> },
      dont: { caption: "One long label truncates the progress away.", render: () => <PillButton surface="glass">Review the activity surface · Validating the activity surface · 2/3</PillButton> },
    },
  ],
  content: ["Title is the task; detail is the current activity; progress is done/total."],
  accessibility: ["Pass aria-label with every part; separators are hidden."],
  tokens: ["--status-capsule-title-max", "--status-capsule-detail-max", "--composer-glass-bg"],
};
