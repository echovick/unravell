// Client-side setup script injected into the Next.js bundle.
// Catches window-level errors (unhandled exceptions + promise rejections)
// and renders a standalone DOM overlay with the AI diagnosis.
//
// React rendering errors are handled separately by UnravelErrorBoundary.

if (typeof window !== "undefined") {
  const UNRAVEL_PORT = 4839;
  const UNRAVEL_URL = `http://localhost:${UNRAVEL_PORT}`;

  // Track whether we're already showing an overlay (avoid duplicates)
  let overlayVisible = false;
  // Track errors the React error boundary already caught
  const handledByBoundary = new WeakSet<Error>();

  // Public API: let the error boundary mark errors as handled
  (window as any).__UNRAVEL_HANDLED = (err: Error) => handledByBoundary.add(err);

  // ─── Overlay Renderer (plain DOM, no React dependency) ───

  function showOverlay(
    errorName: string,
    errorMessage: string,
    errorStack: string,
    diagnosis: any | null,
    loading: boolean
  ) {
    // Remove any existing overlay
    const existing = document.getElementById("unravel-overlay");
    if (existing) existing.remove();

    overlayVisible = true;

    const container = document.createElement("div");
    container.id = "unravel-overlay";
    container.innerHTML = buildOverlayHTML(errorName, errorMessage, errorStack, diagnosis, loading);
    document.body.appendChild(container);

    // Wire up dismiss
    const closeBtn = container.querySelector("[data-unravel-close]");
    if (closeBtn) {
      closeBtn.addEventListener("click", dismissOverlay);
    }

    // Click backdrop to dismiss
    const backdrop = container.querySelector("[data-unravel-backdrop]");
    if (backdrop) {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) dismissOverlay();
      });
    }

    // Wire up tab switching
    container.querySelectorAll("[data-unravel-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = (btn as HTMLElement).dataset.unravelTab!;
        switchTab(container, tab);
      });
    });

    // Wire up copy button
    const copyBtn = container.querySelector("[data-unravel-copy]");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const prompt = container.querySelector("[data-unravel-prompt]")?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(prompt);
          (copyBtn as HTMLElement).textContent = "Copied!";
          setTimeout(() => {
            (copyBtn as HTMLElement).textContent = "Copy to Clipboard";
          }, 2000);
        } catch { /* ignore */ }
      });
    }

    // Escape key to dismiss
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismissOverlay();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  function dismissOverlay() {
    const el = document.getElementById("unravel-overlay");
    if (el) el.remove();
    overlayVisible = false;
  }

  function switchTab(container: HTMLElement, activeTab: string) {
    // Update tab buttons
    container.querySelectorAll("[data-unravel-tab]").forEach((btn) => {
      const el = btn as HTMLElement;
      const isActive = el.dataset.unravelTab === activeTab;
      el.style.color = isActive ? "#e0e0e0" : "#888";
      el.style.borderBottom = isActive ? "2px solid #7c3aed" : "2px solid transparent";
    });
    // Update tab content
    container.querySelectorAll("[data-unravel-panel]").forEach((panel) => {
      const el = panel as HTMLElement;
      el.style.display = el.dataset.unravelPanel === activeTab ? "block" : "none";
    });
  }

  // ─── HTML Builder ───

  function buildOverlayHTML(
    errorName: string,
    errorMessage: string,
    errorStack: string,
    diagnosis: any | null,
    loading: boolean
  ): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const rightPanel = loading
      ? `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px">
           <div style="width:24px;height:24px;border:3px solid #333;border-top-color:#7c3aed;border-radius:50%;animation:unravel-spin 0.8s linear infinite"></div>
           <div style="color:#888;font-size:14px">Analyzing error...</div>
           <div style="color:#555;font-size:12px">Tracing dependencies and gathering context</div>
         </div>`
      : diagnosis
        ? buildDiagnosisHTML(diagnosis)
        : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888">
             Could not analyze this error. Check the stack trace on the left.
           </div>`;

    return `
      <style>
        @keyframes unravel-spin { to { transform: rotate(360deg); } }
        #unravel-overlay * { box-sizing: border-box; margin: 0; padding: 0; }
      </style>
      <div data-unravel-backdrop style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center">
        <div style="width:90vw;max-width:1100px;height:80vh;max-height:700px;background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;box-shadow:0 25px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.08)">
          <div style="display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid #333;background:#1a1a2e;gap:12px;border-radius:12px 12px 0 0">
            <span style="font-weight:700;font-size:16px;color:#7c3aed;flex-shrink:0">Unravel</span>
            <span style="color:#ef4444;font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(errorName)}: ${esc(errorMessage)}</span>
            <button data-unravel-close style="background:none;border:1px solid #555;color:#999;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:14px;flex-shrink:0">&times;</button>
          </div>
          <div style="display:flex;flex:1;overflow:hidden">
            <div style="flex:1;padding:20px;overflow-y:auto;border-right:1px solid #333">
              <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px">Stack Trace</div>
              <pre style="font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#ccc">${esc(errorStack)}</pre>
            </div>
            <div style="flex:1;padding:20px;overflow-y:auto">
              ${rightPanel}
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildDiagnosisHTML(d: any): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const badgeColors: Record<string, string> = {
      high: "background:#166534;color:#4ade80",
      medium: "background:#854d0e;color:#facc15",
      low: "background:#991b1b;color:#fca5a5",
    };
    const badge = badgeColors[d.confidence] ?? badgeColors.low;

    const files = (d.affectedFiles ?? [])
      .map(
        (f: any) => `
        <div style="background:#1e1e2e;border-radius:6px;padding:12px;margin-bottom:8px;border:1px solid #333">
          <div style="font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:12px;color:#7c3aed;margin-bottom:4px">${esc(f.path ?? "")}</div>
          <div style="color:#ef4444;font-size:13px;margin-bottom:4px">${esc(f.issue ?? "")}</div>
          <div style="color:#4ade80;font-size:13px">${esc(f.fix ?? "")}</div>
        </div>`
      )
      .join("");

    const steps = (d.fixGuide ?? [])
      .map(
        (s: string, i: number) =>
          `<div style="padding:8px 0;border-bottom:1px solid #2a2a2a;line-height:1.5"><span style="color:#7c3aed;font-weight:600;margin-right:8px">${i + 1}.</span>${esc(s)}</div>`
      )
      .join("");

    const prevention = d.preventionTip
      ? `<div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px;margin-top:16px">Prevention</div>
         <p style="color:#ccc;line-height:1.5">${esc(d.preventionTip)}</p>`
      : "";

    return `
      <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;${badge}">${esc(d.confidence ?? "low")} confidence</span>
      <div style="font-size:15px;font-weight:500;color:#f0f0f0;margin-top:8px;margin-bottom:16px;line-height:1.5">${esc(d.rootCause ?? "")}</div>

      <div style="display:flex;border-bottom:1px solid #333;margin-bottom:16px">
        <button data-unravel-tab="diagnosis" style="padding:8px 16px;cursor:pointer;border:none;background:none;color:#e0e0e0;font-size:13px;font-weight:500;border-bottom:2px solid #7c3aed">Diagnosis</button>
        <button data-unravel-tab="fix" style="padding:8px 16px;cursor:pointer;border:none;background:none;color:#888;font-size:13px;font-weight:500;border-bottom:2px solid transparent">Fix Guide</button>
        <button data-unravel-tab="ai-prompt" style="padding:8px 16px;cursor:pointer;border:none;background:none;color:#888;font-size:13px;font-weight:500;border-bottom:2px solid transparent">AI Prompt</button>
      </div>

      <div data-unravel-panel="diagnosis" style="display:block">
        <p style="line-height:1.6;color:#ccc;margin-bottom:12px">${esc(d.explanation ?? "")}</p>
        <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px;margin-top:16px">Affected Files</div>
        ${files || '<div style="color:#666">No specific files identified.</div>'}
        ${prevention}
      </div>

      <div data-unravel-panel="fix" style="display:none">
        ${steps || '<div style="color:#666;padding:16px 0">No fix steps available.</div>'}
      </div>

      <div data-unravel-panel="ai-prompt" style="display:none">
        <pre data-unravel-prompt style="font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#ccc;background:#1e1e2e;padding:16px;border-radius:6px;border:1px solid #333">${esc(d.aiPrompt ?? "")}</pre>
        <button data-unravel-copy style="padding:6px 12px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;margin-top:8px">Copy to Clipboard</button>
      </div>`;
  }

  // ─── Error Handlers ───

  async function handleError(errorObj: Error | any, source: string) {
    // Skip if React error boundary already handled this
    if (errorObj instanceof Error && handledByBoundary.has(errorObj)) return;
    // Skip if overlay already showing
    if (overlayVisible) return;

    const errorName = errorObj?.constructor?.name ?? "Error";
    const errorMessage = errorObj?.message ?? String(errorObj);
    const errorStack = errorObj?.stack ?? "";

    // Show loading overlay immediately
    showOverlay(errorName, errorMessage, errorStack, null, true);

    try {
      const response = await fetch(`${UNRAVEL_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: errorMessage,
          stack: errorStack,
        }),
      });

      if (!response.ok) throw new Error(`Server responded ${response.status}`);

      const diagnosis = await response.json();
      // Re-render with diagnosis
      showOverlay(errorName, errorMessage, errorStack, diagnosis, false);
    } catch {
      // Show overlay without diagnosis
      showOverlay(errorName, errorMessage, errorStack, null, false);
    }
  }

  window.addEventListener("error", (event) => {
    handleError(event.error ?? new Error(event.message), "error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    handleError(event.reason, "unhandledrejection");
  });

  console.log("[Unravel] Error diagnostics active");
}
