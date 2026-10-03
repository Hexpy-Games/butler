import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { WallpaperModulesProvider } from "@/components/common/WallpaperModulesProvider.tsx";
import { AppDialogs } from "@/components/common/AppDialogs.tsx";
import { AppShell } from "@/pages/AppShell.tsx";
import { ThinkingMarkHarness } from "@/pages/ThinkingMarkHarness.tsx";
import { ActivityLayoutHarness } from "@/pages/ActivityLayoutHarness.tsx";
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

// Every wallpaper (new chat, dashboards, picker thumbnails) loads images and user modules through the gateway.
createRoot(rootElement).render(
  <ErrorBoundary>
    <WallpaperModulesProvider>
      {visualMode === "thinking-mark"
        ? <ThinkingMarkHarness />
        : visualMode === "components"
          ? new URLSearchParams(window.location.search).get("surface") === "activity-layout" ? <ActivityLayoutHarness /> : <VisualHarness />
          : visualMode === "design-system"
            ? <Suspense fallback={null}><DesignSystemViewer /></Suspense>
            : <AppShell />}
    </WallpaperModulesProvider>
    <AppDialogs />
  </ErrorBoundary>,
);
