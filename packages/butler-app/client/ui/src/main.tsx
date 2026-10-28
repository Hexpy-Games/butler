import { textSizeFactor } from "@/app/textSize";
import { startApp } from "@/app/startApp";
import { installUiCrashReporting } from "@/app/uiCrashReporting.ts";
import { installWallpaperDiagnostics } from "@/app/wallpaperDiagnostics.ts";
import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { WallpaperModulesProvider } from "@/components/common/WallpaperModulesProvider.tsx";
import { AppDialogs } from "@/components/common/AppDialogs.tsx";
import { renderAppSurface } from "@/app/renderAppSurface";
import "@/butler-ds/tokens.css";

const initialTextSize = window.butlerApp?.initialTextSize;
if (initialTextSize) document.documentElement.style.setProperty("--ui-scale", String(textSizeFactor(initialTextSize)));

const visualMode = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("visual")
  : null;

// Review surfaces load only when requested.
const DesignSystemViewer = lazy(() => import("@/butler-ds/viewer/DesignSystemViewer.tsx")
  .then((module) => ({ default: module.DesignSystemViewer })));
installUiCrashReporting();
installWallpaperDiagnostics();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Butler UI root element is missing.");

// Every wallpaper loads images and user modules through the gateway.
void startApp(() => createRoot(rootElement).render(
  <ErrorBoundary>
    <WallpaperModulesProvider>
      {visualMode === "design-system"
        ? <Suspense fallback={null}><DesignSystemViewer /></Suspense>
        : renderAppSurface(visualMode)}
    </WallpaperModulesProvider>
    <AppDialogs />
  </ErrorBoundary>,
), visualMode);
