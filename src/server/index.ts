import express from "express";
import * as path from "path";
import * as fs from "fs";
import { CodeIndexer } from "./indexer";
import { analyzeError } from "./analyzer";
import { classifyError } from "./classifier";
import type { ErrorContext, StackFrame, AnalyzeRequest } from "../shared/types";

const app = express();
app.use(express.json({ limit: "1mb" }));

const projectRoot = process.env.UNRAVEL_PROJECT_ROOT || process.cwd();
const port = parseInt(process.env.UNRAVEL_PORT || "4839", 10);

// ─── API Key Check ───
if (!process.env.UNRAVEL_API_KEY) {
  console.warn(
    "[Unravel] WARNING: UNRAVEL_API_KEY is not set. AI analysis will not work.\n" +
    "[Unravel] Add UNRAVEL_API_KEY=sk-ant-... to your .env file.\n" +
    "[Unravel] Get a key at https://console.anthropic.com/settings/keys"
  );
}

// ─── Indexer ───
const indexer = new CodeIndexer(projectRoot);

indexer.index().then(() => {
  console.log(`[Unravel] Indexed ${indexer.fileCount} files`);
  console.log(`[Unravel] Dependency graph: ${indexer.edgeCount} connections`);
}).catch((err) => {
  console.error(`[Unravel] Indexing failed: ${err.message}`);
});

indexer.watch();

// ─── Graceful Shutdown ───
let server: ReturnType<typeof app.listen>;

function shutdown() {
  console.log("[Unravel] Shutting down...");
  indexer.stopWatching();
  if (server) {
    server.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── CORS ───
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// ─── Health Check ───
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    files: indexer.fileCount,
    edges: indexer.edgeCount,
    hasApiKey: !!process.env.UNRAVEL_API_KEY,
  });
});

// ─── Analysis Endpoint ───
app.post("/analyze", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, stack, componentStack } = req.body as AnalyzeRequest;

    if (!message && !stack) {
      res.status(400).json({ error: "Missing error message or stack trace." });
      return;
    }

    // Check API key before making the call
    if (!process.env.UNRAVEL_API_KEY) {
      res.json({
        rootCause: "Unravel API key is not configured.",
        confidence: "low",
        explanation:
          "Add UNRAVEL_API_KEY to your .env file to enable AI-powered error analysis. " +
          "Get a key at https://console.anthropic.com/settings/keys",
        affectedFiles: [],
        fixGuide: [
          "Step 1: Go to https://console.anthropic.com/settings/keys",
          "Step 2: Create a new API key",
          "Step 3: Add UNRAVEL_API_KEY=sk-ant-... to your project's .env file",
          "Step 4: Restart your dev server",
        ],
        aiPrompt: `Fix this error: ${message ?? "unknown"}\n\nStack: ${stack ?? ""}`,
        preventionTip: "",
        analyzedAt: Date.now(),
      });
      return;
    }

    // 1. Classify the error
    const errorCategory = classifyError(message ?? "", stack ?? "");
    console.log(`[Unravel] Error classified as: ${errorCategory}`);

    // 2. Parse the stack trace to find involved files
    const stackFrames = parseStackTrace(stack ?? "", projectRoot);

    // 3. Gather context from the dependency graph
    const { affectedFiles, dataFlowPath, relatedComponents } =
      indexer.gatherContext(stackFrames, componentStack);

    // 4. Detect framework and TS config
    const framework = detectFramework(projectRoot);
    const tsEnabled = fs.existsSync(path.join(projectRoot, "tsconfig.json"));

    // 5. Build error context
    const context: ErrorContext = {
      error: {
        message: message ?? "",
        stack: stack ?? "",
        componentStack,
        type: extractErrorType(message ?? "", stack ?? ""),
      },
      errorCategory,
      affectedFiles,
      dataFlowPath,
      relatedComponents,
      framework,
      tsEnabled,
    };

    // 6. Send to Claude for analysis
    const diagnosis = await analyzeError(context);

    const elapsed = Date.now() - startTime;
    console.log(
      `[Unravel] Analysis complete in ${elapsed}ms | confidence: ${diagnosis.confidence} | category: ${errorCategory}`
    );

    res.json(diagnosis);
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[Unravel] Analysis failed after ${elapsed}ms:`, err.message);

    res.status(500).json({
      rootCause: "Unravel could not analyze this error.",
      confidence: "low",
      explanation: err.message,
      affectedFiles: [],
      fixGuide: ["Check the stack trace manually"],
      aiPrompt: `Fix this error: ${req.body?.message ?? "unknown"}\n\nStack: ${req.body?.stack ?? ""}`,
      preventionTip: "",
      analyzedAt: Date.now(),
    });
  }
});

// ─── Start Server ───
server = app.listen(port, () => {
  console.log(`[Unravel] Analysis server running on port ${port}`);
});

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[Unravel] Port ${port} is already in use. Another Unravel server may be running.`
    );
  } else {
    console.error(`[Unravel] Server error: ${err.message}`);
  }
});

// ─── Stack Trace Parsing ───

function parseStackTrace(stack: string, root: string): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  const lines = stack.split("\n");

  for (const line of lines) {
    // Standard V8 format: at functionName (filepath:line:col)
    let match = line.match(
      /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/
    );

    // Next.js dev format: filepath (line:col)
    if (!match) {
      match = line.match(/^\s*(.+?)\s+\((\d+):(\d+)\)\s*$/);
      if (match) {
        match = [match[0], undefined as any, match[1], match[2], match[3]];
      }
    }

    if (!match) continue;

    let filepath = match[2];

    // Skip node_modules, node internals, webpack/turbopack internals
    if (
      filepath.includes("node_modules") ||
      filepath.startsWith("node:") ||
      filepath.includes("webpack-internal") ||
      filepath.includes("turbopack") ||
      filepath.includes("<anonymous>") ||
      filepath.startsWith("http://") ||
      filepath.startsWith("https://")
    ) {
      continue;
    }

    // Strip webpack module prefix if present
    filepath = filepath.replace(/^webpack:\/\/\/\.?/, "");

    // Resolve to absolute path if relative
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(root, filepath);
    }

    // Only include files that exist in the project
    try {
      if (filepath.startsWith(root) && fs.existsSync(filepath)) {
        frames.push({
          file: filepath,
          line: parseInt(match[3], 10),
          column: parseInt(match[4], 10),
          functionName: match[1] || undefined,
        });
      }
    } catch {
      // fs.existsSync can throw on malformed paths — skip
    }
  }

  return frames;
}

function extractErrorType(message: string, stack: string): string {
  const match = stack.match(/^(\w+Error):/m) ?? message.match(/^(\w+Error):/);
  return match?.[1] ?? "Error";
}

function detectFramework(
  root: string
): "next-pages" | "next-app" | "react-cra" | "react-vite" {
  try {
    const hasNext =
      fs.existsSync(path.join(root, "next.config.js")) ||
      fs.existsSync(path.join(root, "next.config.mjs")) ||
      fs.existsSync(path.join(root, "next.config.ts"));

    if (hasNext) {
      const hasAppDir =
        fs.existsSync(path.join(root, "app")) ||
        fs.existsSync(path.join(root, "src", "app"));
      return hasAppDir ? "next-app" : "next-pages";
    }

    if (
      fs.existsSync(path.join(root, "vite.config.ts")) ||
      fs.existsSync(path.join(root, "vite.config.js"))
    ) {
      return "react-vite";
    }
  } catch {
    // ignore
  }

  return "react-cra";
}
