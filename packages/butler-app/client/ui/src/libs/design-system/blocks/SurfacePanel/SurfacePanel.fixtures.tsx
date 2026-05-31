import { SurfacePanel } from "./SurfacePanel";
import { PanelHeader } from "../PanelHeader";
import { Typo } from "../../components/Typo";

export function SurfacePanelFixture() {
  return (
    <SurfacePanel>
      <PanelHeader
        title="Inspector"
        description="View conversation details"
      />
      <Typo.Body>Panel content goes here</Typo.Body>
    </SurfacePanel>
  );
}
