import { appCopy } from "@/app/copy.ts";
import React from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Button, Notice } from "@/butler-ds";
import { reportUiCrash } from "@/app/uiCrashReporting.ts";
import { clearCrashSmoke, CrashSmokeProbe } from "./CrashSmokeProbe.tsx";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((retry: () => void) => ReactNode);
  /** A static UI identifier, never a conversation/project title or URL. */
  scope?: string;
}

interface ErrorBoundaryState { error: Error | null }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportUiCrash(error, this.props.scope ?? "app", info.componentStack ?? "");
  }

  private retry = () => {
    clearCrashSmoke(this.props.scope ?? "app");
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (typeof this.props.fallback === "function") return this.props.fallback(this.retry);
      const scoped = Boolean(this.props.scope);
      return this.props.fallback ?? <Notice tone="error"
        message={scoped ? appCopy.interfacePanels.panelCrashed : appCopy.interfacePanels.uiCrashed}
        action={<Button size="sm" variant="outline" onClick={scoped ? this.retry : () => window.location.reload()}>
          {scoped ? appCopy.interfacePanels.retry : appCopy.interfacePanels.reload}
        </Button>} />;
    }
    return <>
      {import.meta.env.MODE === "crash-smoke" && <CrashSmokeProbe scope={this.props.scope ?? "app"} />}
      {this.props.children}
    </>;
  }
}
