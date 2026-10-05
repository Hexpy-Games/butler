import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { DesignSystemViewer } from "@/butler-ds/viewer/DesignSystemViewer.tsx";
import "@/butler-ds/tokens.css";

// Standalone DS Viewer for static hosting. It renders the viewer at its base (the site root, or a
// sub-path such as /ds/ via DS_SITE_BASE) with no Butler gateway: every viewer route lives in query
// params (?page=components/Button), so deep links resolve on any static host without a 404 fallback.
// Design proposals live beside the viewer (?proposal=<id>), lazy-loaded so the viewer bundle is unchanged.
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("DS site root element is missing.");

const params = new URLSearchParams(location.search);
const TaskGraphProposal = lazy(() => import("./proposals/task-graph/index.tsx"));

createRoot(rootElement).render(
  <ErrorBoundary>
    {params.get("proposal") === "task-graph" ? (
      <Suspense>
        <TaskGraphProposal stage={params.get("stage") === "1"} />
      </Suspense>
    ) : (
      <DesignSystemViewer />
    )}
  </ErrorBoundary>,
);
