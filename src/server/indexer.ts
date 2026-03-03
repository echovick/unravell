import * as fs from "fs";
import * as path from "path";
import { GitAnalyzer } from "./git";
import type {
  FileNode,
  Import,
  Export,
  FunctionNode,
  ComponentNode,
  HookUsage,
  ApiCall,
  DependencyEdge,
  AffectedFile,
  StackFrame,
} from "../shared/types";

const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".cache"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export class CodeIndexer {
  private nodes: Map<string, FileNode> = new Map();
  private edges: Map<string, DependencyEdge[]> = new Map();
  private projectRoot: string;
  private git: GitAnalyzer;
  private tsconfigAliases: Record<string, string> = {};

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.git = new GitAnalyzer(projectRoot);
  }

  get fileCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const edges of this.edges.values()) {
      count += edges.length;
    }
    return count;
  }

  /**
   * Index the entire project.
   */
  async index(): Promise<void> {
    this.loadTsconfigAliases();
    const files = this.walkDirectory(this.projectRoot);

    for (const file of files) {
      await this.indexFile(file);
    }

    this.buildEdges();
  }

  /**
   * Re-index a single file (for incremental updates).
   */
  async reindexFile(filepath: string): Promise<void> {
    await this.indexFile(filepath);
    // Rebuild edges for this file and its importers
    this.rebuildEdgesFor(filepath);
  }

  /**
   * Start watching files for changes.
   */
  watch(): void {
    // Chokidar watcher will be wired in Phase 2
  }

  /**
   * Gather context for a set of stack trace files.
   */
  gatherContext(
    stackFrames: StackFrame[],
    _componentStack?: string
  ): {
    affectedFiles: AffectedFile[];
    dataFlowPath: string[];
    relatedComponents: string[];
  } {
    const affectedFiles: AffectedFile[] = [];
    const seen = new Set<string>();

    for (const frame of stackFrames) {
      const relativePath = path.relative(this.projectRoot, frame.file);
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);

      const node = this.nodes.get(relativePath);
      if (!node) continue;

      // Read the relevant code around the error line
      const relevantCode = this.extractRelevantCode(frame.file, frame.line);

      affectedFiles.push({
        path: relativePath,
        relevantCode,
        role: affectedFiles.length === 0 ? "error-origin" : "caller",
        recentChanges: node.recentChanges,
      });

      // Also include direct importers (they might be the actual cause)
      const importers = this.getImportersOf(relativePath);
      for (const imp of importers.slice(0, 3)) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        const impNode = this.nodes.get(imp);
        if (!impNode) continue;

        affectedFiles.push({
          path: imp,
          relevantCode: this.readFileContent(path.join(this.projectRoot, imp)),
          role: "caller",
          recentChanges: impNode.recentChanges,
        });
      }
    }

    // Build data flow path from the stack
    const dataFlowPath = affectedFiles.map((f) => f.path);

    // Find related components
    const relatedComponents: string[] = [];
    for (const af of affectedFiles) {
      const node = this.nodes.get(af.path);
      if (node) {
        relatedComponents.push(...node.components.map((c) => c.name));
      }
    }

    return { affectedFiles, dataFlowPath, relatedComponents };
  }

  // ─── Query Methods ───

  getImportersOf(filepath: string): string[] {
    const importers: string[] = [];
    for (const [file, edges] of this.edges) {
      if (edges.some((e) => e.to === filepath)) {
        importers.push(file);
      }
    }
    return importers;
  }

  getDependenciesOf(filepath: string): string[] {
    const edges = this.edges.get(filepath) ?? [];
    return edges.map((e) => e.to);
  }

  getTransitiveDependents(filepath: string, depth: number): string[] {
    const result = new Set<string>();
    const queue = [filepath];
    let currentDepth = 0;

    while (queue.length > 0 && currentDepth < depth) {
      const nextQueue: string[] = [];
      for (const file of queue) {
        const importers = this.getImportersOf(file);
        for (const imp of importers) {
          if (!result.has(imp)) {
            result.add(imp);
            nextQueue.push(imp);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
      currentDepth++;
    }

    return Array.from(result);
  }

  // ─── Internal Methods ───

  private walkDirectory(dir: string): string[] {
    const files: string[] = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...this.walkDirectory(fullPath));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async indexFile(fullPath: string): Promise<void> {
    const relativePath = path.relative(this.projectRoot, fullPath);
    const content = this.readFileContent(fullPath);
    if (!content) return;

    const imports = this.parseImports(content);
    const exports = this.parseExports(content);
    const functions = this.parseFunctions(content);
    const components = this.parseComponents(content);
    const hooks = this.parseHooks(content);
    const apiCalls = this.parseApiCalls(content);

    const { date, author } = await this.git.getLastModified(relativePath);
    const recentChanges = await this.git.getFileHistory(relativePath, 5);

    const node: FileNode = {
      path: relativePath,
      imports,
      exports,
      functions,
      components,
      hooks,
      apiCalls,
      lastModified: date,
      lastModifiedBy: author,
      recentChanges,
    };

    this.nodes.set(relativePath, node);
  }

  private buildEdges(): void {
    for (const [filepath, node] of this.nodes) {
      const fileEdges: DependencyEdge[] = [];

      for (const imp of node.imports) {
        const resolved = this.resolveImport(imp.source, filepath);
        if (resolved && this.nodes.has(resolved)) {
          fileEdges.push({
            from: filepath,
            to: resolved,
            type: "import",
            symbols: imp.names,
          });
        }
      }

      this.edges.set(filepath, fileEdges);
    }
  }

  private rebuildEdgesFor(filepath: string): void {
    const node = this.nodes.get(filepath);
    if (!node) return;

    const fileEdges: DependencyEdge[] = [];
    for (const imp of node.imports) {
      const resolved = this.resolveImport(imp.source, filepath);
      if (resolved && this.nodes.has(resolved)) {
        fileEdges.push({
          from: filepath,
          to: resolved,
          type: "import",
          symbols: imp.names,
        });
      }
    }
    this.edges.set(filepath, fileEdges);
  }

  private resolveImport(source: string, fromFile: string): string | null {
    // Skip external packages
    if (!source.startsWith(".") && !source.startsWith("/")) {
      // Check tsconfig aliases
      for (const [alias, target] of Object.entries(this.tsconfigAliases)) {
        const aliasPrefix = alias.replace("/*", "");
        if (source.startsWith(aliasPrefix)) {
          const rest = source.slice(aliasPrefix.length);
          source = target.replace("/*", "") + rest;
          break;
        }
      }
      if (!source.startsWith(".") && !source.startsWith("/")) {
        return null;
      }
    }

    const dir = path.dirname(fromFile);
    const resolved = path.join(dir, source);

    // Try extensions
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (this.nodes.has(resolved + ext)) return resolved + ext;
    }

    // Try index files
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const indexPath = path.join(resolved, "index" + ext);
      if (this.nodes.has(indexPath)) return indexPath;
    }

    // Exact match
    if (this.nodes.has(resolved)) return resolved;

    return null;
  }

  private loadTsconfigAliases(): void {
    try {
      const tsconfigPath = path.join(this.projectRoot, "tsconfig.json");
      if (fs.existsSync(tsconfigPath)) {
        const raw = fs.readFileSync(tsconfigPath, "utf-8");
        const tsconfig = JSON.parse(raw);
        const paths = tsconfig.compilerOptions?.paths ?? {};
        for (const [key, value] of Object.entries(paths)) {
          if (Array.isArray(value) && value.length > 0) {
            this.tsconfigAliases[key] = value[0] as string;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // ─── Regex-based Parsing (Phase 1 — replaced by tree-sitter in Phase 2) ───

  private parseImports(content: string): Import[] {
    const imports: Import[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // import { Foo, Bar } from "module"
      const namedMatch = line.match(
        /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/
      );
      if (namedMatch) {
        const names = namedMatch[1].split(",").map((n) => n.trim().split(" as ")[0].trim()).filter(Boolean);
        imports.push({ source: namedMatch[2], names, isDefault: false, line: i + 1 });
        continue;
      }

      // import Foo from "module"
      const defaultMatch = line.match(
        /import\s+(\w+)\s+from\s+["']([^"']+)["']/
      );
      if (defaultMatch) {
        imports.push({ source: defaultMatch[2], names: [defaultMatch[1]], isDefault: true, line: i + 1 });
        continue;
      }

      // import * as Foo from "module"
      const starMatch = line.match(
        /import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/
      );
      if (starMatch) {
        imports.push({ source: starMatch[2], names: [starMatch[1]], isDefault: false, line: i + 1 });
        continue;
      }

      // const Foo = require("module")
      const requireMatch = line.match(
        /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/
      );
      if (requireMatch) {
        const names = requireMatch[1]
          ? requireMatch[1].split(",").map((n) => n.trim()).filter(Boolean)
          : [requireMatch[2]];
        imports.push({ source: requireMatch[3], names, isDefault: !requireMatch[1], line: i + 1 });
      }
    }

    return imports;
  }

  private parseExports(content: string): Export[] {
    const exports: Export[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // export default
      if (line.match(/export\s+default\s/)) {
        exports.push({ name: "default", type: "default", line: i + 1 });
        continue;
      }

      // export function / export const / export class
      const namedExport = line.match(
        /export\s+(?:async\s+)?(function|const|let|var|class|type|interface)\s+(\w+)/
      );
      if (namedExport) {
        const kind = namedExport[1];
        const name = namedExport[2];
        let type: Export["type"] = "constant";
        if (kind === "function" || kind === "class") type = "function";
        if (kind === "type" || kind === "interface") type = "type";
        if (name[0] === name[0].toUpperCase() && kind === "function") type = "component";
        exports.push({ name, type, line: i + 1 });
      }
    }

    return exports;
  }

  private parseFunctions(content: string): FunctionNode[] {
    const functions: FunctionNode[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const match = line.match(
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/
      );
      if (match) {
        const params = match[2]
          .split(",")
          .map((p) => p.trim().split(":")[0].trim())
          .filter(Boolean);
        functions.push({ name: match[1], params, line: i + 1, endLine: i + 1 });
      }

      // Arrow functions assigned to const
      const arrowMatch = line.match(
        /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*\w+)?\s*=>/
      );
      if (arrowMatch) {
        const params = arrowMatch[2]
          .split(",")
          .map((p) => p.trim().split(":")[0].trim())
          .filter(Boolean);
        functions.push({ name: arrowMatch[1], params, line: i + 1, endLine: i + 1 });
      }
    }

    return functions;
  }

  private parseComponents(content: string): ComponentNode[] {
    // Components are functions that start with uppercase
    const components: ComponentNode[] = [];
    const functions = this.parseFunctions(content);
    const hooks = this.parseHooks(content);

    for (const fn of functions) {
      if (fn.name[0] === fn.name[0].toUpperCase() && /[A-Z]/.test(fn.name[0])) {
        components.push({
          name: fn.name,
          props: fn.params,
          hooks: hooks.map((h) => h.name),
          line: fn.line,
          endLine: fn.endLine,
        });
      }
    }

    return components;
  }

  private parseHooks(content: string): HookUsage[] {
    const hooks: HookUsage[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(/\b(use[A-Z]\w*)\s*\(/g);
      for (const match of matches) {
        hooks.push({ name: match[1], line: i + 1 });
      }
    }

    return hooks;
  }

  private parseApiCalls(content: string): ApiCall[] {
    const calls: ApiCall[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // fetch() calls
      const fetchMatch = line.match(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/);
      if (fetchMatch) {
        const method = line.includes("method") ? (line.match(/method:\s*["'](\w+)["']/)?.[1] ?? "GET") : "GET";
        calls.push({ method, endpoint: fetchMatch[1], line: i + 1 });
        continue;
      }

      // axios calls
      const axiosMatch = line.match(/axios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/);
      if (axiosMatch) {
        calls.push({ method: axiosMatch[1].toUpperCase(), endpoint: axiosMatch[2], line: i + 1 });
      }
    }

    return calls;
  }

  private extractRelevantCode(filepath: string, errorLine: number): string {
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, errorLine - 10);
      const end = Math.min(lines.length, errorLine + 10);
      return lines.slice(start, end).join("\n");
    } catch {
      return "";
    }
  }

  private readFileContent(filepath: string): string {
    try {
      return fs.readFileSync(filepath, "utf-8");
    } catch {
      return "";
    }
  }
}
