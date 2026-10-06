import { Suspense, lazy } from "react";
import { AppShell } from "@/pages/AppShell";
import { ThinkingMarkHarness } from "@/pages/ThinkingMarkHarness";
import { ComponentHarness } from "@/pages/ComponentHarness";

const UpdateProgressHarness = lazy(() => import("@/pages/UpdateProgressHarness")
  .then((module) => ({ default: module.UpdateProgressHarness })));

/** Review surfaces load only when requested; the product keeps its AppShell. */
export function renderAppSurface(visualMode: string | null) {
  if (visualMode === "update-progress") return <Suspense fallback={null}><UpdateProgressHarness /></Suspense>;
  if (visualMode === "thinking-mark") return <ThinkingMarkHarness />;
  if (visualMode === "components") return <ComponentHarness />;
  return <AppShell />;
}
