import { WinFixesHarness } from "./WinFixesHarness";
import { ActivityLayoutHarness } from "./ActivityLayoutHarness";
import { QuickFixesHarness } from "./QuickFixesHarness";
import { SettingsErrorsHarness } from "./SettingsErrorsHarness";
import { VisualHarness } from "./VisualHarness";

/** Route the component smoke surfaces while keeping the main entry small. */
export function ComponentHarness() {
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (surface === "win-fixes") return <WinFixesHarness />;
  if (surface === "activity-layout") return <ActivityLayoutHarness />;
  if (surface === "quick-fixes") return <QuickFixesHarness />;
  if (surface === "settings-errors") return <SettingsErrorsHarness />;
  return <VisualHarness />;
}
