import { ChangedLineDiff } from "./ChangedLineDiff";

export function ChangedLineDiffFixture() {
  return (
    <ChangedLineDiff
      ariaLabel="Changed lines"
      id="changed-line-diff-fixture"
      lines={[
        { type: "deleted", old_line: 2, content: "const oldValue = true;" },
        { type: "added", new_line: 2, content: "const newValue = true;" },
        { type: "added", new_line: 98, content: "" },
        { type: "added", new_line: 99, content: '  it("preserves the reusable prefix across different input lengths", () => {' },
        { type: "added", new_line: 100, content: '    const first = items().map((item) => item.section === "runtime_policy" ? { ...item, content: "Current request" } : item);' },
        { type: "added", new_line: 101, content: "  });" },
      ]}
    />
  );
}
