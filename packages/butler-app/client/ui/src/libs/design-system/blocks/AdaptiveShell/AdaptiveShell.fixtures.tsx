import { useState } from "react";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import {
  AdaptiveShell,
  AdaptiveShellInspector,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
} from "./AdaptiveShell";

export function AdaptiveShellFixture() {
  const [panel, setPanel] = useState<"left" | "right" | null>("left");
  return (
    <div style={{ height: 420 }}>
      <AdaptiveShell
        leftOpen={panel === "left"}
        rightOpen={panel === "right"}
        style={{ height: "100%" }}
      >
        <AdaptiveShellSidebar open={panel === "left"}>
          <Stack gap="sm" style={{ padding: "var(--space-md)" }}>
            <Typo.PanelTitle>Navigation</Typo.PanelTitle>
            <Button onClick={() => setPanel(null)}>Close</Button>
          </Stack>
        </AdaptiveShellSidebar>
        <AdaptiveShellWorkspace>
          <Stack gap="sm" style={{ padding: "var(--space-md)" }}>
            <Typo.AppTitle>Workspace</Typo.AppTitle>
            <Button onClick={() => setPanel("left")}>Open navigation</Button>
            <Button onClick={() => setPanel("right")}>Open inspector</Button>
          </Stack>
        </AdaptiveShellWorkspace>
        <AdaptiveShellInspector open={panel === "right"}>
          <Stack gap="sm" style={{ padding: "var(--space-md)" }}>
            <Typo.PanelTitle>Inspector</Typo.PanelTitle>
            <Button onClick={() => setPanel(null)}>Close</Button>
          </Stack>
        </AdaptiveShellInspector>
        <AdaptiveShellScrim
          label="Close panel"
          open={panel !== null}
          onDismiss={() => setPanel(null)}
        />
      </AdaptiveShell>
    </div>
  );
}
