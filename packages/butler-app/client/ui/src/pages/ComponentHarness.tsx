import { ActivityLayoutHarness } from "./ActivityLayoutHarness";
import { QuickFixesHarness } from "./QuickFixesHarness";
import { VisualHarness } from "./VisualHarness";

/** Route the component smoke surfaces while keeping the main entry small. */
export function ComponentHarness() {
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (surface === "activity-layout") return <ActivityLayoutHarness />;
  if (surface === "quick-fixes") return <QuickFixesHarness />;
  return <VisualHarness />;
}
