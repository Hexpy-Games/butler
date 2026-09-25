import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectPillTrigger, SelectValue } from "./Select";
import { PillButton } from "../PillButton";
import { Monitor, GitBranch } from "../Icons";
import { Stack } from "../Stack";

export function SelectFixture() {
  const [value, setValue] = useState("local");
  return (
    <Stack align="row" gap="xs" cross="center" justify="center" wrap data-ds-fixture="select">
      <PillButton surface="glass" icon={<Monitor size="sm" />}>Local</PillButton>
      <Select value={value} onValueChange={setValue}>
        <SelectPillTrigger aria-label="Workspace"
          icon={value === "local" ? <Monitor size="sm" /> : <GitBranch size="sm" />}>
          <SelectValue>{value === "local" ? "Local" : "Worktree"}</SelectValue>
        </SelectPillTrigger>
        <SelectContent position="popper">
          <SelectItem value="local">Local</SelectItem>
          <SelectItem value="worktree">Worktree</SelectItem>
        </SelectContent>
      </Select>
    </Stack>
  );
}
