import { useState } from "react";
import { NativeSelect, NativeSelectOption } from "./NativeSelect";
import { Monitor, GitBranch } from "../Icons";
import { Stack } from "../Stack";

export function NativeSelectFixture() {
  const [value, setValue] = useState("local");
  return (
    <Stack align="row" gap="sm" cross="center" wrap data-ds-fixture="native-select">
      <NativeSelect aria-label="Default select" value={value} onChange={(event) => setValue(event.target.value)}>
        <NativeSelectOption value="local">Local</NativeSelectOption>
        <NativeSelectOption value="worktree">Worktree</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label="Workspace" size="sm" shape="pill"
        icon={value === "local" ? <Monitor size={16} /> : <GitBranch size={16} />}
        value={value} onChange={(event) => setValue(event.target.value)}>
        <NativeSelectOption value="local">Local</NativeSelectOption>
        <NativeSelectOption value="worktree">Worktree</NativeSelectOption>
      </NativeSelect>
    </Stack>
  );
}
