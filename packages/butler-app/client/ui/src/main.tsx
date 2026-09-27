import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { AppConfirmationDialog } from "@/components/common/AppConfirmationDialog.tsx";
import { AppShell } from "@/pages/AppShell.tsx";
import { ThinkingMarkHarness } from "@/pages/ThinkingMarkHarness.tsx";
import { VisualHarness } from "@/pages/VisualHarness.tsx";
import "@/butler-ds/tokens.css";

const visualMode = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("visual")
  : null;

// Loaded only when ?visual=design-system asks for it, so the DS Viewer and its
// showcase fixtures stay out of the main entry chunk.
const DesignSystemViewer = lazy(() => import("@/butler-ds/viewer/DesignSystemViewer.tsx")
  .then((module) => ({ default: module.DesignSystemViewer })));

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Butler UI root element is missing.");

createRoot(rootElement).render(
  <ErrorBoundary>
    {visualMode === "thinking-mark"
      ? <ThinkingMarkHarness />
      : visualMode === "components"
        ? <VisualHarness />
        : visualMode === "design-system"
          ? <Suspense fallback={null}><DesignSystemViewer /></Suspense>
          : <AppShell />}
    <AppConfirmationDialog />
  </ErrorBoundary>,
);
