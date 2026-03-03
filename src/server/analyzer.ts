import Anthropic from "@anthropic-ai/sdk";
import type { ErrorContext, Diagnosis } from "../shared/types";

const SYSTEM_PROMPT = `You are Unravel, a senior debugging assistant for React/Next.js applications. You receive error information along with dependency graph context, affected source code, and recent git history.

Your job is to:
1. Identify the ROOT CAUSE — not the symptom. The stack trace shows where the error surfaced. You need to determine WHY it happened, which is often in a different file.
2. Explain the cause in plain language a mid-level developer would understand.
3. Map the chain of causation — file by file, showing how the problem propagates.
4. Provide a specific, actionable fix with exact file paths and code changes.
5. Generate a prompt that the developer can paste into an AI coding tool (Claude Code, Cursor, Copilot) to apply the fix.

Respond in this exact JSON format:
{
  "rootCause": "One sentence. What actually went wrong and why.",
  "confidence": "high" | "medium" | "low",
  "explanation": "2-4 sentences. The chain of causation in plain language.",
  "affectedFiles": [
    {
      "path": "relative/path/to/file.tsx",
      "issue": "What's wrong in this specific file",
      "fix": "What needs to change here"
    }
  ],
  "fixGuide": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "aiPrompt": "A ready-to-paste prompt for an AI coding tool that includes all necessary context to apply the fix.",
  "preventionTip": "How to prevent this class of error in the future."
}

IMPORTANT: Respond ONLY with the JSON object. No markdown fences, no extra text.`;

function buildAnalysisPrompt(ctx: ErrorContext): string {
  return `
## Error
Type: ${ctx.error.type}
Message: ${ctx.error.message}

## Stack Trace
${ctx.error.stack}

${ctx.error.componentStack ? `## React Component Stack\n${ctx.error.componentStack}` : ""}

## Affected Files (from dependency analysis)
${ctx.affectedFiles
  .map(
    (f) => `
### ${f.path} [${f.role}]
\`\`\`
${f.relevantCode}
\`\`\`
Recent changes:
${f.recentChanges.map((c) => `- ${c.date} by ${c.author}: ${c.message}`).join("\n") || "No recent changes"}
`
  )
  .join("\n")}

## Data Flow Path
${ctx.dataFlowPath.join(" → ")}

## Related Components
${ctx.relatedComponents.join(", ") || "None identified"}

## Project Context
Framework: ${ctx.framework}
TypeScript: ${ctx.tsEnabled}

Analyze this error. Find the root cause, not just the symptom.`;
}

// Simple cache: hash error message + stack trace
const cache = new Map<string, Diagnosis>();

function hashError(message: string, stack: string): string {
  // Simple hash — good enough for deduplication
  const input = `${message}::${stack}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

export async function analyzeError(context: ErrorContext): Promise<Diagnosis> {
  const cacheKey = hashError(context.error.message, context.error.stack);

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = new Anthropic({
    apiKey: process.env.UNRAVEL_API_KEY,
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildAnalysisPrompt(context),
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = JSON.parse(text);

  const diagnosis: Diagnosis = {
    rootCause: parsed.rootCause ?? "Unknown",
    confidence: parsed.confidence ?? "low",
    explanation: parsed.explanation ?? "",
    affectedFiles: parsed.affectedFiles ?? [],
    fixGuide: parsed.fixGuide ?? [],
    aiPrompt: parsed.aiPrompt ?? "",
    preventionTip: parsed.preventionTip ?? "",
    analyzedAt: Date.now(),
  };

  cache.set(cacheKey, diagnosis);

  return diagnosis;
}
