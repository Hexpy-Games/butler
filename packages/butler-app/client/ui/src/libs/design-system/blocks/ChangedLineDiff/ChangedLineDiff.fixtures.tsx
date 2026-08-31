import { ChangedLineDiff } from "./ChangedLineDiff";

export function ChangedLineDiffFixture() {
  return (
    <ChangedLineDiff
      ariaLabel="Changed lines"
      id="changed-line-diff-fixture"
      lines={[
        { type: "deleted", old_line: 2, content: "const oldValue = true;" },
        { type: "added", new_line: 2, content: "const newValue = true;" },
      ]}
    />
  );
}
