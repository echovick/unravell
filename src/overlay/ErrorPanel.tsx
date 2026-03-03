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
    await navigator.clipboard.writeText(diagnosis.aiPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <span style={badgeStyle}>{diagnosis.confidence} confidence</span>
      <div style={overlayStyles.rootCause}>{diagnosis.rootCause}</div>

      <div style={overlayStyles.tabBar}>
        {(["diagnosis", "fix", "ai-prompt"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              ...overlayStyles.tab,
              ...(activeTab === tab ? overlayStyles.tabActive : {}),
            }}
          >
            {tab === "diagnosis" ? "Diagnosis" : tab === "fix" ? "Fix Guide" : "AI Prompt"}
          </button>
        ))}
      </div>

      {activeTab === "diagnosis" && (
        <div>
          <p style={{ lineHeight: 1.6, color: "#ccc" }}>{diagnosis.explanation}</p>
          <div style={overlayStyles.heading}>Affected Files</div>
          {diagnosis.affectedFiles.map((file, i) => (
            <div key={i} style={overlayStyles.fileCard}>
              <div style={overlayStyles.filePath}>{file.path}</div>
              <div style={overlayStyles.fileIssue}>{file.issue}</div>
              <div style={overlayStyles.fileFix}>{file.fix}</div>
            </div>
          ))}
          {diagnosis.preventionTip && (
            <>
              <div style={overlayStyles.heading}>Prevention</div>
              <p style={{ color: "#ccc", lineHeight: 1.5 }}>{diagnosis.preventionTip}</p>
            </>
          )}
        </div>
      )}

      {activeTab === "fix" && (
        <div>
          {diagnosis.fixGuide.map((step, i) => (
            <div key={i} style={overlayStyles.step}>{step}</div>
          ))}
        </div>
      )}

      {activeTab === "ai-prompt" && (
        <div>
          <pre style={overlayStyles.pre}>{diagnosis.aiPrompt}</pre>
          <button onClick={handleCopy} style={overlayStyles.copyBtn}>
            {copied ? "Copied!" : "Copy to Clipboard"}
          </button>
        </div>
      )}
    </div>
  );
}
