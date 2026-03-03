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

const indexer = new CodeIndexer(projectRoot);

// Index the project on startup
indexer.index().then(() => {
  console.log(`[Unravel] Indexed ${indexer.fileCount} files`);
  console.log(`[Unravel] Dependency graph: ${indexer.edgeCount} connections`);
});

// Start watching for changes
indexer.watch();

// CORS — allow the dev browser to reach this server
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

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", files: indexer.fileCount, edges: indexer.edgeCount });
});

// Analysis endpoint
app.post("/analyze", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, stack, componentStack } = req.body as AnalyzeRequest;

    if (!message && !stack) {
      res.status(400).json({ error: "Missing error message or stack trace." });
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

app.listen(port, () => {
  console.log(`[Unravel] Analysis server running on port ${port}`);
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
        // Rearrange captures: [full, filepath, line, col]
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

    // Strip webpack module prefix if present (e.g., "webpack:///./src/foo.tsx")
    filepath = filepath.replace(/^webpack:\/\/\/\.?/, "");

    // Resolve to absolute path if relative
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(root, filepath);
    }

    // Only include files that exist in the project
    if (filepath.startsWith(root) && fs.existsSync(filepath)) {
      frames.push({
        file: filepath,
        line: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
        functionName: match[1] || undefined,
      });
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

  return "react-cra";
}
