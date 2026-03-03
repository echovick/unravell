import Anthropic from "@anthropic-ai/sdk";
import type { ErrorContext, Diagnosis, ErrorCategory } from "../shared/types";

// ─── System Prompt ───

const SYSTEM_PROMPT = `You are Unravel, an expert debugging assistant for React/Next.js applications.

You receive:
- The error (message, stack trace, React component stack)
- Source code of affected files traced through the dependency graph
- Recent git history showing what changed
- The data flow path showing how data reaches the error

Your job:
1. Identify the ROOT CAUSE — not the symptom. The stack trace shows where the error surfaced, but the real cause is often in a different file (a parent passing wrong props, an API returning unexpected data, a recent commit that broke something).
2. Explain the cause clearly so a mid-level developer understands the chain of causation.
3. Provide specific, actionable fixes with exact file paths and code changes.
4. Generate an AI-ready prompt the developer can paste into Claude Code, Cursor, or Copilot to auto-fix the issue.

IMPORTANT RULES:
- Always look at the git history — recent changes are the #1 source of bugs.
- When a value is undefined/null, trace backwards through the prop chain and data flow to find WHERE it became undefined, not just where it crashed.
- Be specific about file paths and line references. Never say "in the component" — say "in src/components/UserCard.tsx".
- If your confidence is low, say so and explain what additional information would help.

Respond ONLY with a valid JSON object in this exact shape (no markdown fences, no extra text):
{
  "rootCause": "One clear sentence explaining what went wrong and why.",
  "confidence": "high" | "medium" | "low",
  "explanation": "2-4 sentences explaining the chain of causation in plain language. Start from the actual source of the problem and trace forward to the crash.",
  "affectedFiles": [
    {
      "path": "relative/path/to/file.tsx",
      "issue": "What's wrong in this specific file",
      "fix": "Exact change needed, with code if possible"
    }
  ],
  "fixGuide": [
    "Step 1: Open file X and change Y to Z",
    "Step 2: ...",
    "Step 3: Verify by ..."
  ],
  "aiPrompt": "A complete, self-contained prompt that an AI coding tool can use to apply the fix. Include the error context, affected files, and exact changes needed.",
  "preventionTip": "One actionable tip to prevent this class of error in the future."
}`;

// ─── Error-Specific Prompt Addons ───

const ERROR_SPECIFIC_PROMPTS: Record<ErrorCategory, string> = {
  "hydration-mismatch": `
## Hydration Mismatch Analysis Instructions

This is a HYDRATION MISMATCH error — the server-rendered HTML differs from what React produces on the client.

Common root causes (check in this order):
1. **Browser-only APIs**: Code using \`window\`, \`document\`, \`localStorage\`, \`navigator\`, or \`Date.now()\` during render — these produce different output on server vs client.
2. **Conditional rendering on client state**: Using \`typeof window !== 'undefined'\` or similar checks that change the render tree.
3. **Extensions/plugins**: Browser extensions injecting elements into the DOM.
4. **Dynamic content without suppression**: Timestamps, random IDs, or user-agent-dependent content rendered without \`suppressHydrationWarning\`.
5. **Incorrect nesting**: Invalid HTML nesting (e.g., \`<p>\` inside \`<p>\`, \`<div>\` inside \`<p>\`) that browsers auto-correct differently.

When diagnosing:
- Look for any \`window\`, \`document\`, \`localStorage\`, or \`navigator\` usage in the component render path.
- Check for \`useEffect\` vs \`useMemo\` confusion — effects run only on client, but initial render must match server.
- Identify the exact component and line where server/client output diverges.
- The fix usually involves: (a) moving the logic into \`useEffect\` + \`useState\`, (b) using \`dynamic(..., { ssr: false })\` in Next.js, or (c) adding \`suppressHydrationWarning\`.`,

  "undefined-property": `
## Undefined Property Analysis Instructions

This is a "Cannot read properties of undefined/null" error — something expected a value but got undefined.

CRITICAL: The error location is NOT the root cause. Trace BACKWARDS to find where the undefined value originated.

Common root causes (check in this order):
1. **Missing prop drilling**: A parent component doesn't pass a required prop, or passes it with the wrong name.
2. **API response mismatch**: An API returns a different shape than expected (missing field, null instead of object, array instead of object).
3. **Optional chaining gap**: Code assumes nested objects exist without checking (\`user.profile.name\` when \`profile\` can be undefined).
4. **Race condition**: Data loaded asynchronously is accessed before it's available (component renders before \`useEffect\` fetch completes).
5. **Destructuring error**: Destructuring a prop/variable that is undefined (\`const { name } = props.user\` when \`user\` is undefined).
6. **State initialization**: \`useState\` initialized as \`undefined\` or \`null\` and accessed before being set.

When diagnosing:
- Start at the crash point and identify WHICH property access failed.
- Walk backwards through the data flow: who provides this value? Is it a prop? From state? From an API?
- Check if the providing component/function can return undefined in any code path.
- Look at recent git changes in the data-providing files — a recent change likely introduced the issue.
- The fix usually involves: (a) adding a null check / optional chaining, (b) fixing the data source, (c) adding a loading state, or (d) providing a default value.`,

  "unhandled-promise": `
## Unhandled Promise / API Error Analysis Instructions

This is an unhandled promise rejection or API error — an async operation failed and the error wasn't caught.

Common root causes (check in this order):
1. **Missing error handling**: \`fetch()\` or API call without \`.catch()\` or \`try/catch\`.
2. **Wrong API endpoint**: URL typo, wrong HTTP method, or hitting a non-existent route.
3. **API route error**: If this is a Next.js API route, check the route handler for crashes.
4. **CORS / network issue**: Cross-origin request blocked, or server unreachable.
5. **Response parsing**: Trying to \`.json()\` parse a non-JSON response (HTML error page, empty response).
6. **Missing environment variable**: API URL or key stored in an env var that's not set.

When diagnosing:
- Identify the exact fetch/API call that failed.
- If it's a Next.js API route, check both the client call AND the API route handler.
- Look for missing \`try/catch\` blocks around \`await\` calls.
- Check if the component handles loading/error states properly.
- The fix usually involves: (a) wrapping in try/catch, (b) adding error state to the component, (c) fixing the API route, or (d) handling non-OK responses (\`if (!res.ok)\`).`,

  general: "",
};

// ─── Prompt Builder ───

function buildAnalysisPrompt(ctx: ErrorContext): string {
  const errorSpecific = ERROR_SPECIFIC_PROMPTS[ctx.errorCategory];

  // Truncate relevant code to stay within token budget
  const truncatedFiles = ctx.affectedFiles.map((f) => ({
    ...f,
    relevantCode: truncateCode(f.relevantCode, 1500),
  }));

  return `${errorSpecific}

## Error
Type: ${ctx.error.type}
Message: ${ctx.error.message}
Category: ${ctx.errorCategory}

## Stack Trace
${truncateCode(ctx.error.stack, 1000)}

${ctx.error.componentStack ? `## React Component Stack\n${truncateCode(ctx.error.componentStack, 500)}` : ""}

## Affected Files (from dependency analysis)
${truncatedFiles
  .map(
    (f) => `
### ${f.path} [${f.role}]
\`\`\`
${f.relevantCode}
\`\`\`
${f.recentChanges.length > 0 ? `Recent changes:\n${f.recentChanges.map((c) => `- ${c.date} by ${c.author}: ${c.message}`).join("\n")}` : "No recent changes."}
`
  )
  .join("\n")}

## Data Flow Path
${ctx.dataFlowPath.join(" → ") || "Not determined"}

## Related Components
${ctx.relatedComponents.join(", ") || "None identified"}

## Project Context
Framework: ${ctx.framework}
TypeScript: ${ctx.tsEnabled}

Analyze this error. Find the root cause, not just the symptom.`;
}

function truncateCode(code: string, maxChars: number): string {
  if (code.length <= maxChars) return code;
  return code.slice(0, maxChars) + "\n... (truncated)";
}

// ─── Cache ───

interface CacheEntry {
  diagnosis: Diagnosis;
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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
  // Evict oldest entries if at capacity
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
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

// ─── Response Parsing ───

function parseDiagnosisJSON(text: string): Record<string, any> {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // continue
    }
  }

  // Try to extract JSON object from surrounding text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // continue
    }
  }

  // Last resort: return a minimal object
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

  const client = new Anthropic({
    apiKey: process.env.UNRAVEL_API_KEY,
  });

  try {
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildAnalysisPrompt(context),
          },
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
    // Return a useful fallback instead of crashing
    const fallback: Diagnosis = {
      rootCause: `Analysis failed: ${err.message}`,
      confidence: "low",
      explanation:
        err.message === "Analysis timed out"
          ? "The AI analysis took too long. This usually happens with very large stack traces. Try refreshing or simplifying the error reproduction."
          : `The analysis engine encountered an error: ${err.message}. The error details are still available in the stack trace on the left.`,
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
${truncateCode(ctx.error.stack, 1000)}

Please identify the root cause and provide a fix.`;
}
