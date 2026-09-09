import { Clickable } from "./Clickable";
import type { CSSProperties } from "react";
import { IconButton } from "../IconButton";
import { Folder } from "../Icons";
import { Stack } from "../Stack";

export function ClickableFixture() {
  return (
    <Stack gap="2">
      <Clickable onClick={() => undefined}>Clickable row</Clickable>
      <Clickable
        onClick={() => undefined}
        style={
          {
            "--clickable-action-size": "var(--control-hit-target)",
            "--clickable-action-icon-size": "var(--space-xl)",
          } as CSSProperties
        }
      >
        <IconButton
          label="Identity action"
          onClick={(event) => event.stopPropagation()}
        >
          <Folder />
        </IconButton>
        Declared identity and touch sizing
      </Clickable>
    </Stack>
  );
}
