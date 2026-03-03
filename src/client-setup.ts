// Client-side setup script injected into the Next.js bundle.
// This will bootstrap the Unravel error boundary and overlay.

if (typeof window !== "undefined") {
  console.log("[Unravel] Error diagnostics active");

  // Listen for unhandled errors and send them to the analysis server
  window.addEventListener("error", async (event) => {
    try {
      const response = await fetch("http://localhost:4839/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: event.error?.message ?? event.message,
          stack: event.error?.stack ?? "",
          type: event.error?.constructor?.name ?? "Error",
        }),
      });
      const diagnosis = await response.json();
      // Will be wired to the overlay in Phase 4
      console.log("[Unravel] Diagnosis:", diagnosis);
    } catch {
      // Silently fail — don't interfere with the developer's workflow
    }
  });

  window.addEventListener("unhandledrejection", async (event) => {
    try {
      const error = event.reason;
      const response = await fetch("http://localhost:4839/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error?.message ?? String(error),
          stack: error?.stack ?? "",
          type: error?.constructor?.name ?? "UnhandledRejection",
        }),
      });
      const diagnosis = await response.json();
      console.log("[Unravel] Diagnosis:", diagnosis);
    } catch {
      // Silently fail
    }
  });
}
