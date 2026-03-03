# Unravel — MVP Build Guide

## What You're Building

An npm package that React/Next.js developers install to replace the default error overlay with an AI-powered diagnostic panel. When an error occurs in development, instead of just seeing a stack trace, they see the root cause, affected files, and a fix guide they can follow manually or paste into their AI coding tool.

**One-line install experience:**

```bash
npm install unravel
```

**One-line config:**

```js
// next.config.js
const withUnravel = require("unravel/next");
module.exports = withUnravel(nextConfig);
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Developer's Browser                            │
│  ┌───────────────────────────────────────────┐  │
│  │  Unravel Overlay (replaces default)       │  │
│  │  ┌─────────────┬───────────────────────┐  │  │
│  │  │ Stack Trace  │  Root Cause Analysis  │  │  │
│  │  │ (standard)   │  (AI-powered)         │  │  │
│  │  │              │  • Diagnosis           │  │  │
│  │  │              │  • Affected files      │  │  │
│  │  │              │  • Fix guide           │  │  │
│  │  │              │  • AI prompt (copy)    │  │  │
│  │  └─────────────┴───────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────┘
                       │ error + context
                       ▼
┌─────────────────────────────────────────────────┐
│  Unravel Local Server (runs alongside dev)      │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Code Indexer  │  │  Analysis Engine        │  │
│  │ • AST parse   │  │  • Receives error       │  │
│  │ • Dep graph   │  │  • Walks dep graph      │  │
│  │ • Git history  │  │  • Gathers context      │  │
│  │ • File watch   │  │  • Calls Claude API     │  │
│  └──────────────┘  │  • Returns diagnosis     │  │
│                     └─────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Phase 1: Project Setup

### Step 1.1 — Initialize the Package

```bash
mkdir unravel && cd unravel
npm init -y
```

Set up the package structure:

```
unravel/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Main export
│   ├── next/
│   │   └── plugin.ts         # Next.js integration (withUnravel)
│   ├── overlay/
│   │   ├── UnravelOverlay.tsx # The error overlay React component
│   │   ├── styles.ts         # Inline styles (no external CSS deps)
│   │   └── ErrorPanel.tsx    # Individual error display panel
│   ├── server/
│   │   ├── index.ts          # Local analysis server
│   │   ├── indexer.ts        # Code indexer (AST + deps)
│   │   ├── git.ts            # Git history analysis
│   │   └── analyzer.ts       # Claude API integration
│   └── shared/
│       └── types.ts          # Shared type definitions
├── dist/                     # Compiled output
└── README.md
```

### Step 1.2 — Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "tree-sitter": "^0.20",
    "tree-sitter-typescript": "^0.20",
    "tree-sitter-javascript": "^0.20",
    "chokidar": "^3.5",
    "express": "^4.18",
    "simple-git": "^3.20"
  },
  "devDependencies": {
    "typescript": "^5.3",
    "react": "^18",
    "react-dom": "^18",
    "@types/react": "^18",
    "@types/express": "^4",
    "tsup": "^8"
  },
  "peerDependencies": {
    "react": ">=17",
    "next": ">=13"
  }
}
```

### Step 1.3 — Build Config

Use `tsup` for building. It handles CJS/ESM dual output cleanly:

```ts
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist",
  },
  {
    entry: ["src/next/plugin.ts"],
    format: ["cjs"],
    outDir: "dist/next",
  },
  {
    entry: ["src/server/index.ts"],
    format: ["cjs"],
    outDir: "dist/server",
  },
]);
```

---

## Phase 2: The Code Indexer

This is the "brain" component — it understands the project structure.

### Step 2.1 — AST Parsing with Tree-sitter

Build a parser that extracts the structural information you need from every JS/TS/JSX/TSX file:

**What to extract per file:**

- All exports (named, default) with their types (function, component, constant, type)
- All imports (what they import, from where)
- Function/component signatures (name, parameters, return type if available)
- Hook usage (useState, useEffect, useContext, custom hooks)
- API calls (fetch, axios, etc.) with endpoint strings if detectable
- Error boundaries (classes extending React error boundary)

**Output format — a `FileNode` for each file:**

```ts
interface FileNode {
  path: string;
  exports: Export[];
  imports: Import[];
  functions: FunctionNode[];
  components: ComponentNode[];
  hooks: HookUsage[];
  apiCalls: ApiCall[];
  lastModified: string; // from git
  lastModifiedBy: string; // from git
  recentChanges: GitChange[]; // last 5 commits touching this file
}
```

### Step 2.2 — Dependency Graph

After parsing every file, build a graph of relationships:

```ts
interface DependencyGraph {
  nodes: Map<string, FileNode>; // filepath -> node
  edges: Map<string, DependencyEdge[]>; // filepath -> edges

  // Query methods
  getImportersOf(filepath: string): string[]; // who imports this file?
  getDependenciesOf(filepath: string): string[]; // what does this file import?
  getComponentTree(componentName: string): TreeNode; // parent-child rendering
  traceDataFlow(from: string, to: string): Path[]; // how does data get from A to B?
}

interface DependencyEdge {
  from: string; // source filepath
  to: string; // target filepath
  type:
    | "import"
    | "render"
    | "api-call"
    | "context-provider"
    | "hook-dependency";
  symbols: string[]; // which specific exports are used
}
```

**Implementation approach:**

- Walk the project directory, skip node_modules and .next
- Parse each JS/TS/JSX/TSX file with tree-sitter
- Resolve import paths to actual files (handle aliases from tsconfig.json / jsconfig.json)
- Build adjacency lists for the graph
- Store in memory (for MVP, no database needed — projects under 100k files are fine in RAM)

### Step 2.3 — Git History Layer

For each file in the graph, attach recent git history:

```ts
interface GitChange {
  hash: string;
  message: string;
  author: string;
  date: string;
  diff: string; // the actual change (abbreviated)
  filesChanged: string[]; // other files changed in same commit
}
```

Use `simple-git` to extract:

- Last 5 commits per file
- Files changed together (co-change patterns)
- Recent project-wide changes (last 20 commits)

This is critical because the #1 answer to "why is this broken?" is "someone changed something recently."

### Step 2.4 — File Watcher

Use `chokidar` to watch for file changes and incrementally update the graph:

```ts
// Watch for changes, re-parse only affected files
watcher.on("change", (filepath) => {
  const node = reparse(filepath);
  graph.updateNode(filepath, node);
  // Also re-resolve edges for files that import this one
  graph.getImportersOf(filepath).forEach((imp) => graph.updateEdges(imp));
});
```

This keeps the graph fresh without full re-indexing.

---

## Phase 3: The Analysis Engine

### Step 3.1 — Error Context Gathering

When an error comes in, gather everything the AI needs to diagnose it:

```ts
interface ErrorContext {
  // The error itself
  error: {
    message: string;
    stack: string;
    componentStack?: string; // React-specific
    type: string; // TypeError, ReferenceError, etc.
  };

  // Traced from the dependency graph
  affectedFiles: {
    path: string;
    relevantCode: string; // the specific function/component, not whole file
    role: string; // "error origin" | "caller" | "data source" | "provider"
    recentChanges: GitChange[];
  }[];

  // From the dep graph
  dataFlowPath: string[]; // how data flows through the affected components
  relatedComponents: string[]; // siblings, parents, children in render tree

  // Project context
  framework: "next-pages" | "next-app" | "react-cra" | "react-vite";
  tsEnabled: boolean;
}
```

**The gathering process:**

1. Parse the stack trace to identify files and line numbers
2. Look up each file in the dependency graph
3. For the file where the error originated, get its importers (who renders/calls it?)
4. For each file in the chain, extract the relevant function/component code (not the whole file)
5. Get recent git changes for all files in the chain
6. Identify the data flow path — how does data reach the error point?

### Step 3.2 — Claude API Integration

Send the gathered context to Claude for diagnosis:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.UNRAVEL_API_KEY,
});

async function analyzeError(context: ErrorContext): Promise<Diagnosis> {
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

  return parseDiagnosis(response.content[0].text);
}
```

**The system prompt (this is your secret sauce — iterate on it heavily):**

```ts
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
}`;
```

**The analysis prompt builder:**

```ts
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
${f.recentChanges.map((c) => `- ${c.date} by ${c.author}: ${c.message}`).join("\n")}
`,
  )
  .join("\n")}

## Data Flow Path
${ctx.dataFlowPath.join(" → ")}

## Project Context
Framework: ${ctx.framework}
TypeScript: ${ctx.tsEnabled}

Analyze this error. Find the root cause, not just the symptom.`;
}
```

### Step 3.3 — Response Parsing and Caching

Parse Claude's JSON response into your `Diagnosis` type. Add basic caching so the same error doesn't trigger repeat API calls:

```ts
interface Diagnosis {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  explanation: string;
  affectedFiles: AffectedFile[];
  fixGuide: string[];
  aiPrompt: string;
  preventionTip: string;
  analyzedAt: number;
}

// Simple cache: hash the error message + stack trace
const cache = new Map<string, Diagnosis>();
```

---

## Phase 4: The Overlay UI

### Step 4.1 — Intercepting Next.js Errors

Next.js uses a WebSocket-based error overlay. You have two approaches:

**Approach A — Custom Error Boundary + Middleware (recommended for MVP):**

```tsx
// UnravelErrorBoundary.tsx
// Wraps the app, catches React errors, shows your overlay instead of the default
class UnravelErrorBoundary extends React.Component {
  state = { error: null, diagnosis: null, loading: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  async componentDidCatch(error, errorInfo) {
    this.setState({ loading: true });

    // Send to local Unravel server for analysis
    const diagnosis = await fetch("http://localhost:4839/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      }),
    }).then((r) => r.json());

    this.setState({ diagnosis, loading: false });
  }

  render() {
    if (this.state.error) {
      return (
        <UnravelOverlay
          error={this.state.error}
          diagnosis={this.state.diagnosis}
          loading={this.state.loading}
        />
      );
    }
    return this.props.children;
  }
}
```

**Approach B — Intercept the webpack/turbopack HMR overlay:**

This is harder but provides a more seamless experience. Next.js's dev overlay listens on `__NEXT_HMR_CB`. You can monkey-patch the error handler to inject your analysis. Save this for v2.

### Step 4.2 — The Overlay Component

The overlay should have two panels:

**Left panel:** The standard error info (message, stack trace, component stack) — what developers already expect.

**Right panel:** Unravel's analysis — the root cause, affected files, fix guide, and the copy-paste AI prompt.

```tsx
function UnravelOverlay({ error, diagnosis, loading }) {
  const [activeTab, setActiveTab] = useState("diagnosis");

  return (
    <div style={overlayStyles.container}>
      <div style={overlayStyles.header}>
        <span style={overlayStyles.logo}>⚡ Unravel</span>
        <span style={overlayStyles.errorType}>
          {error.name}: {error.message}
        </span>
        <button onClick={dismiss} style={overlayStyles.closeBtn}>
          ✕
        </button>
      </div>

      <div style={overlayStyles.body}>
        {/* Left: Standard error info */}
        <div style={overlayStyles.leftPanel}>
          <h3>Stack Trace</h3>
          <pre>{error.stack}</pre>
        </div>

        {/* Right: Unravel analysis */}
        <div style={overlayStyles.rightPanel}>
          {loading ? (
            <LoadingState />
          ) : diagnosis ? (
            <>
              <ConfidenceBadge level={diagnosis.confidence} />
              <RootCause text={diagnosis.rootCause} />
              <Tabs active={activeTab} onChange={setActiveTab}>
                <Tab id="diagnosis" label="Diagnosis">
                  <Explanation text={diagnosis.explanation} />
                  <AffectedFiles files={diagnosis.affectedFiles} />
                </Tab>
                <Tab id="fix" label="Fix Guide">
                  <FixSteps steps={diagnosis.fixGuide} />
                </Tab>
                <Tab id="ai-prompt" label="AI Prompt">
                  <CopyablePrompt prompt={diagnosis.aiPrompt} />
                </Tab>
              </Tabs>
              <PreventionTip text={diagnosis.preventionTip} />
            </>
          ) : (
            <FallbackMessage />
          )}
        </div>
      </div>
    </div>
  );
}
```

### Step 4.3 — Styling

Use inline styles only — no CSS imports, no Tailwind dependency, nothing that touches the developer's build pipeline:

- Dark background (#1a1a2e or similar)
- Monospace font for code, sans-serif for explanations
- Red accent for errors, green for fixes, yellow for warnings
- Confidence badge: green (high), yellow (medium), red (low)
- Copy button on the AI prompt that copies to clipboard with visual feedback
- The overlay should feel like an upgrade to what they're used to, not a foreign UI

---

## Phase 5: The Next.js Plugin

### Step 5.1 — withUnravel Wrapper

```ts
// src/next/plugin.ts
const { spawn } = require("child_process");

function withUnravel(nextConfig = {}) {
  // Only run in development
  if (process.env.NODE_ENV !== "development") return nextConfig;

  // Start the Unravel analysis server as a background process
  let serverProcess = null;

  return {
    ...nextConfig,
    webpack(config, options) {
      if (options.isServer && !serverProcess) {
        // Start analysis server on first webpack build
        serverProcess = spawn(
          "node",
          [require.resolve("unravel/dist/server")],
          {
            env: {
              ...process.env,
              UNRAVEL_PROJECT_ROOT: process.cwd(),
              UNRAVEL_PORT: "4839",
            },
            stdio: "pipe",
            detached: false,
          },
        );

        serverProcess.stdout.on("data", (data) => {
          console.log(`[Unravel] ${data}`);
        });
      }

      // Inject the error boundary wrapper into the client bundle
      if (!options.isServer) {
        const originalEntry = config.entry;
        config.entry = async () => {
          const entries = await originalEntry();
          // Add Unravel's client-side setup script
          if (entries["main-app"]) {
            entries["main-app"].unshift(
              require.resolve("unravel/dist/client-setup"),
            );
          }
          return entries;
        };
      }

      return typeof nextConfig.webpack === "function"
        ? nextConfig.webpack(config, options)
        : config;
    },
  };
}

module.exports = withUnravel;
```

### Step 5.2 — The Local Analysis Server

```ts
// src/server/index.ts
import express from "express";
import { CodeIndexer } from "./indexer";
import { analyzeError } from "./analyzer";

const app = express();
app.use(express.json());

const projectRoot = process.env.UNRAVEL_PROJECT_ROOT || process.cwd();
const indexer = new CodeIndexer(projectRoot);

// Index the project on startup
indexer.index().then(() => {
  console.log(`[Unravel] Indexed ${indexer.fileCount} files`);
  console.log(`[Unravel] Dependency graph: ${indexer.edgeCount} connections`);
});

// Start watching for changes
indexer.watch();

// Analysis endpoint
app.post("/analyze", async (req, res) => {
  try {
    const { message, stack, componentStack } = req.body;

    // 1. Parse the stack trace to find involved files
    const stackFiles = parseStackTrace(stack, projectRoot);

    // 2. Gather context from the dependency graph
    const context = indexer.gatherContext(stackFiles, componentStack);

    // 3. Send to Claude for analysis
    const diagnosis = await analyzeError(context);

    res.json(diagnosis);
  } catch (err) {
    console.error("[Unravel] Analysis failed:", err);
    res.status(500).json({
      rootCause: "Unravel could not analyze this error.",
      confidence: "low",
      explanation: err.message,
      affectedFiles: [],
      fixGuide: ["Check the stack trace manually"],
      aiPrompt: `Fix this error: ${req.body.message}\n\nStack: ${req.body.stack}`,
      preventionTip: "",
    });
  }
});

app.listen(4839, () => {
  console.log("[Unravel] Analysis server running on port 4839");
});
```

---

## Phase 6: The Three Target Errors (Ship These First)

Don't try to handle every error well. Nail these three first. They're the most common and the most painful in React/Next.js.

### Error 1: Hydration Mismatch

**What developers see:** "Text content does not match server-rendered HTML"
**What they need:** Which component renders differently on server vs client, and why.

Your tool traces the component tree, identifies where server output diverges from client output (often a Date, window reference, or conditional rendering based on browser state), and points to the exact line.

### Error 2: "Cannot read properties of undefined"

**What developers see:** A crash in component X, line Y.
**What they need:** Where the undefined value actually originated — usually a parent component passing wrong props, an API returning unexpected data, or a missing null check three components up.

Your tool walks the prop chain and data flow backwards from the crash point to find where the undefined was introduced.

### Error 3: Unhandled Promise Rejection / API Errors

**What developers see:** A failed fetch or an unhandled rejection that crashes a component.
**What they need:** Why the API call failed, what the component expected vs what it got, and whether the error handling is missing or broken.

Your tool checks the API route (if it's a Next.js API route, you have the source), the fetch call, and the component's error handling to explain the full chain.

---

## Phase 7: Build Sequence (What to Code in What Order)

Follow this exact order. Each step produces something testable.

### Week 1: Foundation

1. Project setup (package.json, tsconfig, tsup)
2. Type definitions (types.ts — all interfaces)
3. Stack trace parser (extract file paths and line numbers from error stacks)
4. Basic file indexer (read all JS/TS/JSX/TSX files, extract imports/exports)
5. Test: feed it a real Next.js project, verify it maps imports correctly

### Week 2: Dependency Graph

6. Import resolution (handle aliases, relative paths, package imports)
7. Build adjacency list graph from imports
8. Git history integration (recent changes per file)
9. Context gatherer (given a list of files from a stack trace, collect relevant code + graph context)
10. Test: give it a stack trace, verify it collects the right files and code

### Week 3: Analysis Engine

11. Claude API integration (send context, get diagnosis)
12. System prompt engineering (test with real errors, iterate on prompt quality)
13. Response parsing and validation
14. Basic caching (don't re-analyze identical errors)
15. Test: feed it the 3 target error types, verify diagnosis quality

### Week 4: Overlay + Integration

16. Build the overlay React component
17. Build the error boundary wrapper
18. Build the express analysis server
19. Build the Next.js plugin (withUnravel)
20. End-to-end test: install in a real Next.js project, trigger errors, see diagnoses

### Week 5: Polish + Ship

21. Loading states, error states, edge cases
22. Copy-to-clipboard for AI prompt
23. Confidence calibration (test accuracy across 20+ real errors)
24. README, docs, npm publish
25. Record demo video

---

## API Key Handling

The developer needs a Claude API key. For MVP, keep it simple:

```bash
# Developer adds to .env
UNRAVEL_API_KEY=sk-ant-...
```

Later (v2+), you can offer a hosted option where they use your key via a proxy and you handle billing. But for MVP, BYOK (bring your own key) eliminates your infrastructure costs and billing complexity entirely.

---

## Key Technical Decisions

**Why tree-sitter over babel/typescript parser?**
Tree-sitter is incremental — it can re-parse a single changed file in milliseconds. Babel re-parses from scratch. For a file watcher that needs to keep the graph fresh, tree-sitter is significantly faster. It also handles JSX/TSX natively.

**Why a local server instead of doing everything client-side?**
The indexer needs filesystem access. The Claude API key should never be in the browser bundle. The analysis is too heavy for the browser. The server runs alongside the dev server and shares the same lifecycle.

**Why not a VS Code extension instead?**
The overlay approach meets developers where they already are — looking at the browser when something breaks. A VS Code extension requires context-switching. The overlay is zero-friction. You can always add a VS Code extension later as a complementary surface.

**Why Sonnet and not Opus for the API?**
Sonnet is faster and cheaper. For error analysis, speed matters more than raw reasoning power — the developer is waiting. Sonnet is more than capable of diagnosing code errors given good context. You can offer Opus as a premium option later for complex analyses.

---

## What Claude Code Prompts to Use

When building with Claude Code, give it clear context per task. Here are ready-to-use prompts for each major component:

### For the indexer:

> "Build a TypeScript module that uses tree-sitter to parse all .ts, .tsx, .js, .jsx files in a directory (excluding node_modules and .next). For each file, extract: all import statements (source path and imported names), all export statements (name and type), all function/component declarations with their parameter names. Return results as a Map<string, FileNode> where keys are relative file paths. Handle TypeScript path aliases by reading tsconfig.json."

### For the dependency graph:

> "Build a DependencyGraph class that takes a Map<string, FileNode> and constructs an adjacency list of file dependencies. Include methods: getImportersOf(path) returns all files that import the given path, getDependenciesOf(path) returns all files the given path imports, getTransitiveDependents(path, depth) returns all files affected by changes to the given path up to N levels deep. Handle circular dependencies gracefully."

### For the analyzer:

> "Build an analyzeError function that takes an ErrorContext object (containing error message, stack trace, component stack, affected file contents, and git history) and sends it to the Claude API using @anthropic-ai/sdk. The system prompt should instruct Claude to respond in JSON with fields: rootCause, confidence, explanation, affectedFiles, fixGuide, aiPrompt, preventionTip. Parse and validate the response. Cache results by error hash to avoid duplicate API calls."

### For the overlay:

> "Build a React component called UnravelOverlay that renders as a full-screen error overlay with a dark theme. Left side shows the standard stack trace. Right side shows AI analysis with tabs for Diagnosis, Fix Guide, and AI Prompt. Include a loading state with a subtle animation, a confidence badge (green/yellow/red), and a copy-to-clipboard button on the AI Prompt tab. Use inline styles only — no CSS imports. The component should be self-contained with no external dependencies besides React."

---

## Success Criteria for MVP

Before you show this to anyone, it should:

- [ ] Install with one npm command
- [ ] Configure with one line in next.config.js
- [ ] Not slow down the dev server noticeably (indexing under 5s for projects up to 500 files)
- [ ] Show the overlay within 1 second of an error occurring
- [ ] Return an AI diagnosis within 5 seconds
- [ ] Correctly diagnose at least 7 out of 10 common React/Next.js errors
- [ ] Generate a copy-paste AI prompt that, when given to Claude Code or Cursor, produces the correct fix at least 70% of the time
- [ ] Not crash, hang, or interfere with the developer's workflow when it can't analyze something

---

## After MVP: What Comes Next

Once the core works, the roadmap writes itself:

**v1.1** — Vite/React (non-Next.js) support
**v1.2** — VS Code extension (show diagnosis inline, not just in overlay)
**v1.3** — Runtime error monitoring (catch errors in staging/preview deploys)
**v2.0** — Team features (shared graph, team-wide error patterns, "this error has happened 3 times this week")
**v2.5** — Laravel Ignition integration (your home turf)
**v3.0** — The full brain — persistent codebase understanding across sessions, the platform layer other tools plug into

But none of that matters until v1 works and developers love it. Build the overlay. Nail the three errors. Ship it.
