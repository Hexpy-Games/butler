import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { DesignSystemViewer } from "@/butler-ds/viewer/DesignSystemViewer.tsx";
import "@/butler-ds/tokens.css";

// Standalone DS Viewer for static hosting. It renders the viewer at its base (the site root, or a
// sub-path such as /ds/ via DS_SITE_BASE) with no Butler gateway: every viewer route lives in query
// params (?page=components/Button), so deep links resolve on any static host without a 404 fallback.
// Design proposals (?page=proposals/<id>) are site-only pages outside the DS source tree.
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("DS site root element is missing.");

const PROPOSALS = {
  "proposals/composer-decorations": lazy(() =>
    import("./proposals/composer-decorations/ComposerDecorationsPage").then((module) => ({ default: module.ComposerDecorationsPage }))),
} as const;

const page = new URLSearchParams(window.location.search).get("page") ?? "";
const Proposal = PROPOSALS[page as keyof typeof PROPOSALS];

createRoot(rootElement).render(
  <ErrorBoundary>
    {Proposal ? <Suspense fallback={null}><Proposal /></Suspense> : <DesignSystemViewer />}
  </ErrorBoundary>,
);
