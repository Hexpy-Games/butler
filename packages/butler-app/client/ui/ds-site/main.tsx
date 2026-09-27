import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { DesignSystemViewer } from "@/butler-ds/viewer/DesignSystemViewer.tsx";
import "@/butler-ds/tokens.css";

// Standalone DS Viewer for static hosting (butler-design.hexpy.games). It renders the viewer at the
// site root with no Butler gateway: every viewer route lives in query params (?page=components/Button),
// so deep links resolve on any static host without a 404 fallback.
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("DS site root element is missing.");

createRoot(rootElement).render(
  <ErrorBoundary>
    <DesignSystemViewer />
  </ErrorBoundary>,
);
