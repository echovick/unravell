import React from "react";
import type { Diagnosis } from "../shared/types";
import { overlayStyles } from "./styles";
import { ErrorPanel } from "./ErrorPanel";

interface UnravelOverlayProps {
  error: Error;
  diagnosis: Diagnosis | null;
  loading: boolean;
  onDismiss?: () => void;
}

export function UnravelOverlay({ error, diagnosis, loading, onDismiss }: UnravelOverlayProps) {
  return (
    <div style={overlayStyles.container}>
      {/* Inject keyframe animation for spinner */}
      <style>{`@keyframes unravel-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={overlayStyles.header}>
        <span style={overlayStyles.logo}>Unravel</span>
        <span style={overlayStyles.errorType}>
          {error.name}: {error.message}
        </span>
        {onDismiss && (
          <button onClick={onDismiss} style={overlayStyles.closeBtn}>
            &times;
          </button>
        )}
      </div>

      <div style={overlayStyles.body}>
        {/* Left panel: standard error info */}
        <div style={overlayStyles.leftPanel}>
          <div style={overlayStyles.heading}>Stack Trace</div>
          <pre style={overlayStyles.pre}>{error.stack}</pre>
        </div>

        {/* Right panel: Unravel analysis */}
        <div style={overlayStyles.rightPanel}>
          {loading ? (
            <div style={overlayStyles.loadingContainer}>
              <div style={overlayStyles.spinner} />
              <div style={overlayStyles.loadingText}>Analyzing error...</div>
            </div>
          ) : diagnosis ? (
            <ErrorPanel diagnosis={diagnosis} />
          ) : (
            <div style={overlayStyles.loadingContainer}>
              <div style={overlayStyles.loadingText}>
                Could not analyze this error. Check the stack trace on the left.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Error boundary that wraps the app and shows the Unravel overlay
interface BoundaryState {
  error: Error | null;
  diagnosis: Diagnosis | null;
  loading: boolean;
}

export class UnravelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null, diagnosis: null, loading: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  async componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ loading: true });

    try {
      const response = await fetch("http://localhost:4839/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
        }),
      });
      const diagnosis: Diagnosis = await response.json();
      this.setState({ diagnosis, loading: false });
    } catch {
      this.setState({ loading: false });
    }
  }

  handleDismiss = () => {
    this.setState({ error: null, diagnosis: null, loading: false });
  };

  render() {
    if (this.state.error) {
      return (
        <UnravelOverlay
          error={this.state.error}
          diagnosis={this.state.diagnosis}
          loading={this.state.loading}
          onDismiss={this.handleDismiss}
        />
      );
    }
    return this.props.children;
  }
}
