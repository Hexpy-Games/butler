import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { WallpaperModulesProvider } from "@/components/common/WallpaperModulesProvider.tsx";
import { AppDialogs } from "@/components/common/AppDialogs.tsx";
import { AppShell } from "@/pages/AppShell.tsx";
import { ThinkingMarkHarness } from "@/pages/ThinkingMarkHarness.tsx";
import { ComponentHarness } from "@/pages/ComponentHarness.tsx";
import "@/butler-ds/tokens.css";

const visualMode = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("visual")
  : null;

// Review surfaces load only when requested.
const DesignSystemViewer = lazy(() => import("@/butler-ds/viewer/DesignSystemViewer.tsx")
  .then((module) => ({ default: module.DesignSystemViewer })));
const UpdateProgressHarness = lazy(() => import("@/pages/UpdateProgressHarness")
  .then((module) => ({ default: module.UpdateProgressHarness })));
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Butler UI root element is missing.");

createRoot(rootElement).render(
  <ErrorBoundary>
    <WallpaperModulesProvider>
      {visualMode === "update-progress"
        ? <Suspense fallback={null}><UpdateProgressHarness /></Suspense>
        : visualMode === "thinking-mark"
        ? <ThinkingMarkHarness />
        : visualMode === "components"
          ? <ComponentHarness />
          : visualMode === "design-system"
            ? <Suspense fallback={null}><DesignSystemViewer /></Suspense>
            : <AppShell />}
    </WallpaperModulesProvider>
    <AppDialogs />
  </ErrorBoundary>,
);
