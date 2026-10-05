import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { DesignSystemViewer } from "@/butler-ds/viewer/DesignSystemViewer.tsx";
import "@/butler-ds/tokens.css";

// Standalone DS Viewer for static hosting. It renders the viewer at its base (the site root, or a
// sub-path such as /ds/ via DS_SITE_BASE) with no Butler gateway: every viewer route lives in query
// params (?page=components/Button), so deep links resolve on any static host without a 404 fallback.
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("DS site root element is missing.");

// Design proposals live beside the viewer (?proposal=<id>), lazy-loaded so the viewer bundle is unchanged.
const params = new URLSearchParams(location.search);
const LifecycleWindowsProposal = lazy(() => import("./proposals/lifecycle-windows/index.tsx"));

createRoot(rootElement).render(
  <ErrorBoundary>
    {params.get("proposal") === "lifecycle-windows" ? <Suspense><LifecycleWindowsProposal stage={params.get("stage")} /></Suspense> : <DesignSystemViewer />}
  </ErrorBoundary>,
);
