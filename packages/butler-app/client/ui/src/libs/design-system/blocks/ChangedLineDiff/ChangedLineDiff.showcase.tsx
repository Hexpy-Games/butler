import { useId, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { DisclosureRow } from "../DisclosureRow";
import { ChangedLineDiff, type ChangedLineDiffLine } from "./ChangedLineDiff";

export const meta: ShowcaseMeta = {
  title: "ChangedLineDiff",
  category: "Conversation & Activity",
  tags: ["diff", "code", "changed-files", "conversation"],
  status: "stable",
};

const labels = {
  "en-US": { region: (path: string) => `Changed lines in ${path}`, counts: "+4 −1" },
  "ko-KR": { region: (path: string) => `${path}의 변경된 줄`, counts: "+4 −1" },
} as const;

const PATH = "src/libs/design-system/lib/motion.test.ts";
const LINES: ChangedLineDiffLine[] = [
  { type: "deleted", old_line: 2, content: "const oldValue = true;" },
  { type: "added", new_line: 2, content: "const newValue = true;" },
  { type: "added", new_line: 98, content: "" },
  { type: "added", new_line: 99, content: '  it("preserves the reusable prefix across different input lengths", () => {' },
  { type: "added", new_line: 100, content: '    const first = items().map((item) => item.section === "runtime_policy" ? { ...item, content: "Current request" } : item);' },
  { type: "added", new_line: 101, content: "  });" },
];

/** MessageChangedFileRow: the diff is the body of a plain DisclosureRow. */
function ChangedFile({ context }: { context: ShowcaseRenderContext }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <DisclosureRow controlsId={id} icon={<FileText size="lg" />} meta={labels[context.locale].counts} open={open} surface="plain"
      title={PATH} onToggle={() => setOpen((value) => !value)}>
      <ChangedLineDiff ariaLabel={labels[context.locale].region(PATH)} id={id} lines={LINES} />
    </DisclosureRow>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Standalone", widths: ["375", "app", "wide"], render: (context) => <ChangedLineDiff ariaLabel={labels[context.locale].region(PATH)} id="ds-diff" lines={LINES} /> },
  { name: "Inside a changed-file row", widths: ["320", "375", "app"], render: (context) => <ChangedFile context={context} /> },
];
