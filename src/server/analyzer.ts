import Anthropic from "@anthropic-ai/sdk";
import type { ErrorContext, Diagnosis, ErrorCategory } from "../shared/types";

// ─── Singleton Client ───

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.UNRAVEL_API_KEY });
  }
  return _client;
}

// ─── System Prompt (compact for speed) ───

const SYSTEM_PROMPT = `You are Unravel, a React/Next.js debugging assistant. Given an error with stack trace, source code, and git history, respond with a JSON object:
{"rootCause":"One sentence: what went wrong and why","confidence":"high|medium|low","explanation":"2-3 sentences tracing cause to crash","affectedFiles":[{"path":"file.tsx","issue":"what's wrong","fix":"exact change needed"}],"fixGuide":["Step 1: ...","Step 2: ..."],"aiPrompt":"Prompt for AI coding tool to auto-fix","preventionTip":"One tip to prevent this"}
Rules: find ROOT CAUSE not symptom. Check git history. Be specific with file paths. Output ONLY valid JSON, no markdown fences.`;

// ─── Error-Specific Hints (short) ───

const ERROR_HINTS: Record<ErrorCategory, string> = {
  "hydration-mismatch":
    "HYDRATION MISMATCH: server HTML differs from client. Check for browser-only APIs (window/document/localStorage/Date.now()) in render, conditional rendering on client state, invalid HTML nesting. Fix: useEffect+useState, dynamic({ssr:false}), or suppressHydrationWarning.",
  "undefined-property":
    "UNDEFINED PROPERTY: trace BACKWARDS from crash to find where the value became undefined. Check: missing props, API response shape mismatch, missing optional chaining, race condition (render before fetch), destructuring undefined.",
  "unhandled-promise":
    "UNHANDLED PROMISE: async operation failed without catch. Check: missing try/catch around fetch/await, wrong API endpoint, CORS issues, .json() on non-JSON response, missing env vars.",
  general: "",
};

// ─── Prompt Builder ───

function buildAnalysisPrompt(ctx: ErrorContext): string {
  const hint = ERROR_HINTS[ctx.errorCategory];

  // Only send top 2 affected files to reduce tokens
  const files = ctx.affectedFiles.slice(0, 2).map(
    (f) =>
      `### ${f.path} [${f.role}]\n\`\`\`\n${truncate(f.relevantCode, 1200)}\n\`\`\`${
        f.recentChanges.length > 0
          ? `\nRecent: ${f.recentChanges
              .slice(0, 3)
              .map((c) => `${c.message} (${c.author})`)
              .join("; ")}`
          : ""
      }`
  );

  return `${hint ? hint + "\n\n" : ""}Error: ${ctx.error.type}: ${ctx.error.message}
Category: ${ctx.errorCategory}

Stack (key frames):
${truncate(ctx.error.stack, 800)}
${ctx.error.componentStack ? `\nComponent stack:\n${truncate(ctx.error.componentStack, 300)}` : ""}

${files.join("\n\n")}
${ctx.dataFlowPath.length > 0 ? `\nData flow: ${ctx.dataFlowPath.join(" → ")}` : ""}
${ctx.relatedComponents.length > 0 ? `Components: ${ctx.relatedComponents.join(", ")}` : ""}
Framework: ${ctx.framework} | TS: ${ctx.tsEnabled}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n...";
}

// ─── Cache ───

interface CacheEntry {
  diagnosis: Diagnosis;
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 100;
const cache = new Map<string, CacheEntry>();

function getCached(key: string): Diagnosis | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.diagnosis;
}

function setCache(key: string, diagnosis: Diagnosis): void {
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { diagnosis, timestamp: Date.now() });
}

function hashError(message: string, stack: string): string {
  const input = `${message}::${stack}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ─── Response Parsing ───

function parseDiagnosisJSON(text: string): Record<string, any> {
  // The response starts with `{` due to prefill, so try direct parse
  const fullText = "{" + text;
  try {
    return JSON.parse(fullText);
  } catch {
    // continue
  }

  // Try extracting JSON object
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // continue
    }
  }

  // Fallback
  return {
    rootCause: "Unable to parse analysis response.",
    confidence: "low",
    explanation: text.slice(0, 500),
    affectedFiles: [],
    fixGuide: ["Review the error manually."],
    aiPrompt: "",
    preventionTip: "",
  };
}

function validateDiagnosis(parsed: Record<string, any>): Diagnosis {
  const confidence = ["high", "medium", "low"].includes(parsed.confidence)
    ? (parsed.confidence as "high" | "medium" | "low")
    : "low";

  const affectedFiles = Array.isArray(parsed.affectedFiles)
    ? parsed.affectedFiles.map((f: any) => ({
        path: String(f.path ?? ""),
        issue: String(f.issue ?? ""),
        fix: String(f.fix ?? ""),
      }))
    : [];

  const fixGuide = Array.isArray(parsed.fixGuide)
    ? parsed.fixGuide.map(String)
    : [];

  return {
    rootCause: String(parsed.rootCause ?? "Unknown error"),
    confidence,
    explanation: String(parsed.explanation ?? ""),
    affectedFiles,
    fixGuide,
    aiPrompt: String(parsed.aiPrompt ?? ""),
    preventionTip: String(parsed.preventionTip ?? ""),
    analyzedAt: Date.now(),
  };
}

// ─── Main Analysis Function ───

const API_TIMEOUT_MS = 15_000;

export async function analyzeError(context: ErrorContext): Promise<Diagnosis> {
  const cacheKey = hashError(context.error.message, context.error.stack);

  const cached = getCached(cacheKey);
  if (cached) return cached;

  const client = getClient();

  try {
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: buildAnalysisPrompt(context) },
          { role: "assistant", content: "{" },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out")), API_TIMEOUT_MS)
      ),
    ]);

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const parsed = parseDiagnosisJSON(text);
    const diagnosis = validateDiagnosis(parsed);

    setCache(cacheKey, diagnosis);
    return diagnosis;
  } catch (err: any) {
    const fallback: Diagnosis = {
      rootCause: `Analysis failed: ${err.message}`,
      confidence: "low",
      explanation:
        err.message === "Analysis timed out"
          ? "The AI analysis took too long. Try refreshing."
          : `Analysis error: ${err.message}. Check the stack trace on the left.`,
      affectedFiles: [],
      fixGuide: ["Review the stack trace manually to identify the error source."],
      aiPrompt: buildFallbackPrompt(context),
      preventionTip: "",
      analyzedAt: Date.now(),
    };
    return fallback;
  }
}

function buildFallbackPrompt(ctx: ErrorContext): string {
  const files = ctx.affectedFiles
    .map((f) => `- ${f.path} (${f.role})`)
    .join("\n");

  return `Fix this ${ctx.errorCategory} error in my ${ctx.framework} project:

Error: ${ctx.error.message}

Affected files:
${files}

Stack trace:
${truncate(ctx.error.stack, 1000)}

Please identify the root cause and provide a fix.`;
}
