import React from "react";
import type { Diagnosis } from "../shared/types";
import { overlayStyles } from "./styles";
import { ErrorPanel } from "./ErrorPanel";

interface UnravelOverlayProps {
  error: Error;
  diagnosis: Diagnosis | null;
  loading: boolean;
  componentStack?: string;
  onDismiss?: () => void;
}

export function UnravelOverlay({
  error,
  diagnosis,
  loading,
  componentStack,
  onDismiss,
}: UnravelOverlayProps) {
  // Escape key to dismiss
  React.useEffect(() => {
    if (!onDismiss) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && onDismiss) onDismiss();
  };

  return (
    <div style={overlayStyles.backdrop} onClick={handleBackdropClick}>
      <div style={overlayStyles.container}>
        <style>{`
          @keyframes unravel-spin { to { transform: rotate(360deg); } }
          @keyframes unravel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        `}</style>

        {/* Header */}
        <div style={overlayStyles.header}>
          <span style={overlayStyles.logo}>Unravel</span>
          <span style={overlayStyles.errorType}>
            {error.name}: {error.message}
          </span>
          {onDismiss && (
            <button onClick={onDismiss} style={overlayStyles.closeBtn} title="Dismiss (Esc)">
              &times;
            </button>
          )}
        </div>

        {/* Body */}
        <div style={overlayStyles.body}>
          {/* Left panel: standard error info */}
          <div style={overlayStyles.leftPanel}>
            <div style={overlayStyles.heading}>Stack Trace</div>
            <pre style={overlayStyles.pre}>{error.stack}</pre>

            {componentStack && (
              <>
                <div style={{ ...overlayStyles.heading, marginTop: "24px" }}>
                  Component Stack
                </div>
                <pre style={overlayStyles.pre}>{componentStack}</pre>
              </>
            )}
          </div>

          {/* Right panel: Unravel analysis */}
          <div style={overlayStyles.rightPanel}>
            {loading ? (
              <LoadingState />
            ) : diagnosis ? (
              <ErrorPanel diagnosis={diagnosis} />
            ) : (
              <FallbackState />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  const [step, setStep] = React.useState(0);
  const steps = [
    "Parsing stack trace...",
    "Tracing dependency graph...",
    "Gathering affected files...",
    "Analyzing with AI...",
  ];

  React.useEffect(() => {
    const timers = steps.map((_, i) =>
      setTimeout(() => setStep(i), i * 1500)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div style={overlayStyles.loadingContainer}>
      <div style={overlayStyles.spinner} />
      <div style={overlayStyles.loadingText}>{steps[step]}</div>
      <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
        {steps.map((_, i) => (
          <div
            key={i}
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: i <= step ? "#7c3aed" : "#333",
              transition: "background-color 0.3s",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function FallbackState() {
  return (
    <div style={overlayStyles.loadingContainer}>
      <div style={{ color: "#ef4444", fontSize: "24px", marginBottom: "8px" }}>!</div>
      <div style={overlayStyles.loadingText}>
        Could not connect to the Unravel analysis server.
      </div>
      <div style={{ color: "#666", fontSize: "12px", maxWidth: "300px", textAlign: "center", lineHeight: 1.5 }}>
        Make sure the server is running on port 4839. Check the stack trace on the left for manual debugging.
      </div>
    </div>
  );
}

// ─── Error Boundary ───

interface BoundaryState {
  error: Error | null;
  diagnosis: Diagnosis | null;
  loading: boolean;
  componentStack: string;
}

export class UnravelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null, diagnosis: null, loading: false, componentStack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  async componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const componentStack = errorInfo.componentStack ?? "";
    this.setState({ loading: true, componentStack });

    // Tell the client-setup this error is handled by the boundary
    if (typeof window !== "undefined" && (window as any).__UNRAVEL_HANDLED) {
      (window as any).__UNRAVEL_HANDLED(error);
    }

    try {
      const response = await fetch("http://localhost:4839/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message,
          stack: error.stack,
          componentStack,
        }),
      });

      if (!response.ok) throw new Error(`Server responded ${response.status}`);

      const diagnosis: Diagnosis = await response.json();
      this.setState({ diagnosis, loading: false });
    } catch {
      this.setState({ loading: false });
    }
  }

  handleDismiss = () => {
    this.setState({ error: null, diagnosis: null, loading: false, componentStack: "" });
  };

  render() {
    if (this.state.error) {
      return (
        <UnravelOverlay
          error={this.state.error}
          diagnosis={this.state.diagnosis}
          loading={this.state.loading}
          componentStack={this.state.componentStack}
          onDismiss={this.handleDismiss}
        />
      );
    }
    return this.props.children;
  }
}
