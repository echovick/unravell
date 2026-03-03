// ─── File Indexer Types ───

export interface Export {
  name: string;
  type: "function" | "component" | "constant" | "type" | "default";
  line: number;
}

export interface Import {
  source: string; // the module path (e.g., "./utils" or "react")
  names: string[]; // imported identifiers
  isDefault: boolean;
  line: number;
}

export interface FunctionNode {
  name: string;
  params: string[];
  returnType?: string;
  line: number;
  endLine: number;
}

export interface ComponentNode {
  name: string;
  props: string[];
  hooks: string[];
  line: number;
  endLine: number;
}

export interface HookUsage {
  name: string; // e.g., "useState", "useEffect"
  line: number;
}

export interface ApiCall {
  method: string; // GET, POST, etc.
  endpoint?: string; // if statically detectable
  line: number;
}

export interface GitChange {
  hash: string;
  message: string;
  author: string;
  date: string;
  diff: string;
  filesChanged: string[];
}

export interface FileNode {
  path: string;
  exports: Export[];
  imports: Import[];
  functions: FunctionNode[];
  components: ComponentNode[];
  hooks: HookUsage[];
  apiCalls: ApiCall[];
  lastModified: string;
  lastModifiedBy: string;
  recentChanges: GitChange[];
}

// ─── Dependency Graph Types ───

export interface DependencyEdge {
  from: string;
  to: string;
  type: "import" | "render" | "api-call" | "context-provider" | "hook-dependency";
  symbols: string[];
}

export interface DependencyGraph {
  nodes: Map<string, FileNode>;
  edges: Map<string, DependencyEdge[]>;

  getImportersOf(filepath: string): string[];
  getDependenciesOf(filepath: string): string[];
  getTransitiveDependents(filepath: string, depth: number): string[];
}

// ─── Error Classification ───

export type ErrorCategory =
  | "hydration-mismatch"
  | "undefined-property"
  | "unhandled-promise"
  | "general";

// ─── Error Analysis Types ───

export interface ErrorInfo {
  message: string;
  stack: string;
  componentStack?: string;
  type: string; // TypeError, ReferenceError, etc.
}

export interface AffectedFile {
  path: string;
  relevantCode: string;
  role: "error-origin" | "caller" | "data-source" | "provider";
  recentChanges: GitChange[];
}

export interface ErrorContext {
  error: ErrorInfo;
  errorCategory: ErrorCategory;
  affectedFiles: AffectedFile[];
  dataFlowPath: string[];
  relatedComponents: string[];
  framework: "next-pages" | "next-app" | "react-cra" | "react-vite";
  tsEnabled: boolean;
}

export interface DiagnosisFile {
  path: string;
  issue: string;
  fix: string;
}

export interface Diagnosis {
  rootCause: string;
  confidence: "high" | "medium" | "low";
  explanation: string;
  affectedFiles: DiagnosisFile[];
  fixGuide: string[];
  aiPrompt: string;
  preventionTip: string;
  analyzedAt: number;
}

// ─── Server Types ───

export interface AnalyzeRequest {
  message: string;
  stack: string;
  componentStack?: string;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  functionName?: string;
}
