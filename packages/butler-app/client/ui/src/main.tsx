import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { AppShell } from "@/pages/AppShell.tsx";
import { ThinkingMarkHarness } from "@/pages/ThinkingMarkHarness.tsx";
import { VisualHarness } from "@/pages/VisualHarness.tsx";
import { DesignSystemWorkbench } from "@/butler-ds/fixtures/DesignSystemWorkbench.tsx";
import "@/butler-ds/tokens.css";

const visualMode = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("visual")
  : null;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Butler UI root element is missing.");

createRoot(rootElement).render(
  <ErrorBoundary>
    {visualMode === "thinking-mark"
      ? <ThinkingMarkHarness />
      : visualMode === "components"
        ? <VisualHarness />
        : visualMode === "design-system"
          ? <DesignSystemWorkbench />
          : <AppShell />}
  </ErrorBoundary>,
);
