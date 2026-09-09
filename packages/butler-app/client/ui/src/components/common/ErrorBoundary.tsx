import { appCopy } from "@/app/copy.ts";
import React from "react";
import type { ReactNode } from "react";
import { Notice } from "@/butler-ds";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback ?? (
        <Notice
          tone="error"
          title={appCopy.interfacePanels.uiCrashed}
          message={appCopy.interfacePanels.reload}
        />
      );
    }

    return this.props.children;
  }
}
