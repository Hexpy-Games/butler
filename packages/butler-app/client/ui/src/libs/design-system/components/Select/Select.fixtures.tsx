import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";

/** Registry fixture: a plain form select. The composer's Local/Worktree chip
 * is a ComposerSelectControl (see the ComposerControl showcase). */
export function SelectFixture() {
  const [value, setValue] = useState("one");
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label="Example select" data-ds-fixture="select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">One</SelectItem>
        <SelectItem value="two">Two</SelectItem>
      </SelectContent>
    </Select>
  );
}
