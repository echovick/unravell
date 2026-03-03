import React from "react";
import type { Diagnosis } from "../shared/types";
import { overlayStyles } from "./styles";

interface ErrorPanelProps {
  diagnosis: Diagnosis;
}

export function ErrorPanel({ diagnosis }: ErrorPanelProps) {
  const [activeTab, setActiveTab] = React.useState<"diagnosis" | "fix" | "ai-prompt">("diagnosis");
  const [copied, setCopied] = React.useState(false);

  const badgeStyle = {
    ...overlayStyles.badge,
    ...(diagnosis.confidence === "high"
      ? overlayStyles.badgeHigh
      : diagnosis.confidence === "medium"
        ? overlayStyles.badgeMedium
        : overlayStyles.badgeLow),
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosis.aiPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = diagnosis.aiPrompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const tabs = [
    { id: "diagnosis" as const, label: "Diagnosis" },
    { id: "fix" as const, label: "Fix Guide" },
    { id: "ai-prompt" as const, label: "AI Prompt" },
  ];

  return (
    <div>
      {/* Confidence + Root Cause */}
      <span style={badgeStyle}>{diagnosis.confidence} confidence</span>
      <div style={overlayStyles.rootCause}>{diagnosis.rootCause}</div>

      {/* Tabs */}
      <div style={overlayStyles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              ...overlayStyles.tab,
              ...(activeTab === tab.id ? overlayStyles.tabActive : {}),
            }}
          >
            {tab.label}
            {tab.id === "fix" && diagnosis.fixGuide.length > 0 && (
              <span style={overlayStyles.tabCount}>{diagnosis.fixGuide.length}</span>
            )}
            {tab.id === "diagnosis" && diagnosis.affectedFiles.length > 0 && (
              <span style={overlayStyles.tabCount}>{diagnosis.affectedFiles.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Diagnosis tab */}
      {activeTab === "diagnosis" && (
        <div>
          <p style={{ lineHeight: 1.6, color: "#ccc", marginBottom: "16px" }}>
            {diagnosis.explanation}
          </p>

          {diagnosis.affectedFiles.length > 0 && (
            <>
              <div style={overlayStyles.heading}>Affected Files</div>
              {diagnosis.affectedFiles.map((file, i) => (
                <div key={i} style={overlayStyles.fileCard}>
                  <div style={overlayStyles.filePath}>{file.path}</div>
                  <div style={overlayStyles.fileIssue}>{file.issue}</div>
                  <div style={overlayStyles.fileFix}>{file.fix}</div>
                </div>
              ))}
            </>
          )}

          {diagnosis.preventionTip && (
            <div style={overlayStyles.preventionBox}>
              <div style={overlayStyles.preventionLabel}>Prevention Tip</div>
              <div style={overlayStyles.preventionText}>{diagnosis.preventionTip}</div>
            </div>
          )}
        </div>
      )}

      {/* Fix Guide tab */}
      {activeTab === "fix" && (
        <div>
          {diagnosis.fixGuide.length > 0 ? (
            diagnosis.fixGuide.map((step, i) => (
              <div key={i} style={overlayStyles.step}>
                <span style={overlayStyles.stepNumber}>{i + 1}</span>
                {step}
              </div>
            ))
          ) : (
            <div style={{ color: "#666", padding: "24px 0", textAlign: "center" }}>
              No specific fix steps were generated. Review the diagnosis tab.
            </div>
          )}
        </div>
      )}

      {/* AI Prompt tab */}
      {activeTab === "ai-prompt" && (
        <div>
          {diagnosis.aiPrompt ? (
            <>
              <div style={{ color: "#888", fontSize: "12px", marginBottom: "8px" }}>
                Paste this prompt into Claude Code, Cursor, or Copilot to auto-fix the issue:
              </div>
              <pre style={overlayStyles.promptBox}>{diagnosis.aiPrompt}</pre>
              <button
                onClick={handleCopy}
                style={{
                  ...overlayStyles.copyBtn,
                  ...(copied ? overlayStyles.copyBtnSuccess : {}),
                }}
              >
                {copied ? "Copied!" : "Copy to Clipboard"}
              </button>
            </>
          ) : (
            <div style={{ color: "#666", padding: "24px 0", textAlign: "center" }}>
              No AI prompt was generated for this error.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
