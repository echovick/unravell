import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
import { GitAnalyzer } from "./git";
import { parseFile } from "./parser";
import type {
  FileNode,
  DependencyEdge,
  AffectedFile,
  StackFrame,
} from "../shared/types";

const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".cache", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export class CodeIndexer {
  private nodes: Map<string, FileNode> = new Map();
  private edges: Map<string, DependencyEdge[]> = new Map();
  // Reverse index: filepath -> list of files that import it
  private reverseEdges: Map<string, Set<string>> = new Map();
  private projectRoot: string;
  private git: GitAnalyzer;
  private tsconfigAliases: Record<string, string> = {};
  private baseUrl: string = "";
  private watcher: chokidar.FSWatcher | null = null;

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

  // ─── Indexing ───

  /**
   * Index the entire project.
   */
  async index(): Promise<void> {
    this.loadPathAliases();
    const files = this.walkDirectory(this.projectRoot);

    // Parse files in parallel batches for speed
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((f) => this.indexFile(f)));
    }

    this.buildEdges();
  }

  /**
   * Re-index a single file and update the graph.
   */
  async reindexFile(filepath: string): Promise<void> {
    const fullPath = path.isAbsolute(filepath)
      ? filepath
      : path.join(this.projectRoot, filepath);
    const relativePath = path.relative(this.projectRoot, fullPath);

    if (!fs.existsSync(fullPath)) {
      // File was deleted — remove from graph
      this.removeFile(relativePath);
      return;
    }

    await this.indexFile(fullPath);
    this.rebuildEdgesFor(relativePath);

    // Also re-resolve edges for files that import this one
    const importers = this.getImportersOf(relativePath);
    for (const imp of importers) {
      this.rebuildEdgesFor(imp);
    }
  }

  /**
   * Start watching files for changes via chokidar.
   */
  watch(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored: [
        "**/node_modules/**",
        "**/.next/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.cache/**",
        "**/coverage/**",
      ],
      persistent: true,
      ignoreInitial: true,
    });

    const handleChange = async (filepath: string) => {
      const ext = path.extname(filepath);
      if (!SOURCE_EXTENSIONS.has(ext)) return;

      console.log(`[Unravel] File changed: ${path.relative(this.projectRoot, filepath)}`);
      await this.reindexFile(filepath);
    };

    this.watcher.on("change", handleChange);
    this.watcher.on("add", handleChange);
    this.watcher.on("unlink", (filepath) => {
      const relativePath = path.relative(this.projectRoot, filepath);
      this.removeFile(relativePath);
      console.log(`[Unravel] File removed: ${relativePath}`);
    });
  }

  /**
   * Stop watching for changes.
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Context Gathering ───

  /**
   * Gather context for a set of stack trace files to send to the analyzer.
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

      // Extract relevant code around the error line
      const relevantCode = this.extractRelevantCode(frame.file, frame.line);

      affectedFiles.push({
        path: relativePath,
        relevantCode,
        role: affectedFiles.length === 0 ? "error-origin" : "caller",
        recentChanges: node.recentChanges,
      });

      // Include direct importers — they might be the actual cause
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

    const dataFlowPath = affectedFiles.map((f) => f.path);

    const relatedComponents: string[] = [];
    for (const af of affectedFiles) {
      const node = this.nodes.get(af.path);
      if (node) {
        relatedComponents.push(...node.components.map((c) => c.name));
      }
    }

    return { affectedFiles, dataFlowPath, relatedComponents };
  }

  // ─── Graph Query Methods ───

  /**
   * Get all files that import the given filepath.
   */
  getImportersOf(filepath: string): string[] {
    return Array.from(this.reverseEdges.get(filepath) ?? []);
  }

  /**
   * Get all files that the given filepath imports.
   */
  getDependenciesOf(filepath: string): string[] {
    const edges = this.edges.get(filepath) ?? [];
    return [...new Set(edges.map((e) => e.to))];
  }

  /**
   * Get all transitive dependents up to N levels deep.
   */
  getTransitiveDependents(filepath: string, depth: number): string[] {
    const result = new Set<string>();
    let frontier = [filepath];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const imp of this.getImportersOf(file)) {
          if (!result.has(imp) && imp !== filepath) {
            result.add(imp);
            next.push(imp);
          }
        }
      }
      frontier = next;
    }

    return Array.from(result);
  }

  /**
   * Build the component render tree starting from a named component.
   * Returns a tree of component names based on which components render which.
   */
  getComponentTree(componentName: string): { name: string; children: any[] } | null {
    // Find the file that defines this component
    let defFile: string | null = null;
    for (const [filepath, node] of this.nodes) {
      if (node.components.some((c) => c.name === componentName) ||
          node.exports.some((e) => e.name === componentName)) {
        defFile = filepath;
        break;
      }
    }
    if (!defFile) return null;

    return this.buildComponentSubtree(componentName, defFile, new Set());
  }

  /**
   * Trace the data flow path between two files.
   * Returns all shortest paths through the import graph.
   */
  traceDataFlow(from: string, to: string): string[][] {
    if (from === to) return [[from]];

    // BFS to find shortest paths
    const queue: string[][] = [[from]];
    const visited = new Set<string>([from]);
    const paths: string[][] = [];
    let shortestLength = Infinity;

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      if (currentPath.length > shortestLength) break;

      const current = currentPath[currentPath.length - 1];
      const deps = this.getDependenciesOf(current);
      const importers = this.getImportersOf(current);
      const neighbors = [...deps, ...importers];

      for (const neighbor of neighbors) {
        const newPath = [...currentPath, neighbor];

        if (neighbor === to) {
          paths.push(newPath);
          shortestLength = newPath.length;
          continue;
        }

        if (!visited.has(neighbor) && newPath.length < shortestLength) {
          visited.add(neighbor);
          queue.push(newPath);
        }
      }
    }

    return paths;
  }

  // ─── Internal: File System ───

  private walkDirectory(dir: string): string[] {
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
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

  private readFileContent(filepath: string): string {
    try {
      return fs.readFileSync(filepath, "utf-8");
    } catch {
      return "";
    }
  }

  private extractRelevantCode(filepath: string, errorLine: number): string {
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, errorLine - 15);
      const end = Math.min(lines.length, errorLine + 15);
      return lines.slice(start, end).join("\n");
    } catch {
      return "";
    }
  }

  // ─── Internal: Indexing ───

  private async indexFile(fullPath: string): Promise<void> {
    const relativePath = path.relative(this.projectRoot, fullPath);
    const content = this.readFileContent(fullPath);
    if (!content) return;

    // Parse with SWC AST parser
    const parsed = parseFile(content, fullPath);

    const { date, author } = await this.git.getLastModified(relativePath);
    const recentChanges = await this.git.getFileHistory(relativePath, 5);

    const node: FileNode = {
      path: relativePath,
      imports: parsed.imports,
      exports: parsed.exports,
      functions: parsed.functions,
      components: parsed.components,
      hooks: parsed.hooks,
      apiCalls: parsed.apiCalls,
      lastModified: date,
      lastModifiedBy: author,
      recentChanges,
    };

    this.nodes.set(relativePath, node);
  }

  private removeFile(relativePath: string): void {
    this.nodes.delete(relativePath);
    // Clean up forward edges
    this.edges.delete(relativePath);
    // Clean up reverse edges
    for (const [, importers] of this.reverseEdges) {
      importers.delete(relativePath);
    }
    this.reverseEdges.delete(relativePath);
  }

  // ─── Internal: Edge Building ───

  private buildEdges(): void {
    this.edges.clear();
    this.reverseEdges.clear();

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

          // Update reverse index
          if (!this.reverseEdges.has(resolved)) {
            this.reverseEdges.set(resolved, new Set());
          }
          this.reverseEdges.get(resolved)!.add(filepath);
        }
      }

      this.edges.set(filepath, fileEdges);
    }
  }

  private rebuildEdgesFor(filepath: string): void {
    const node = this.nodes.get(filepath);
    if (!node) return;

    // Remove old reverse edges for this file
    const oldEdges = this.edges.get(filepath) ?? [];
    for (const edge of oldEdges) {
      this.reverseEdges.get(edge.to)?.delete(filepath);
    }

    // Build new forward edges
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

        // Update reverse index
        if (!this.reverseEdges.has(resolved)) {
          this.reverseEdges.set(resolved, new Set());
        }
        this.reverseEdges.get(resolved)!.add(filepath);
      }
    }

    this.edges.set(filepath, fileEdges);
  }

  // ─── Internal: Import Resolution ───

  private resolveImport(source: string, fromFile: string): string | null {
    // Skip external packages (no relative/absolute path, no alias match)
    if (!source.startsWith(".") && !source.startsWith("/")) {
      // Check tsconfig/jsconfig path aliases
      const aliased = this.resolveAlias(source);
      if (aliased) {
        source = aliased;
      } else if (this.baseUrl) {
        // Try baseUrl resolution
        const baseResolved = path.join(this.baseUrl, source);
        const result = this.tryResolve(baseResolved);
        if (result) return result;
        return null;
      } else {
        return null;
      }
    }

    const dir = path.dirname(fromFile);
    const resolved = path.join(dir, source);
    return this.tryResolve(resolved);
  }

  private resolveAlias(source: string): string | null {
    for (const [alias, target] of Object.entries(this.tsconfigAliases)) {
      const aliasPrefix = alias.replace("/*", "").replace("*", "");

      if (alias.includes("*")) {
        // Wildcard alias: @/* -> src/*
        if (source.startsWith(aliasPrefix)) {
          const rest = source.slice(aliasPrefix.length);
          const targetBase = target.replace("/*", "").replace("*", "");
          return "./" + path.join(targetBase, rest);
        }
      } else {
        // Exact alias: @components -> src/components
        if (source === aliasPrefix || source.startsWith(aliasPrefix + "/")) {
          const rest = source.slice(aliasPrefix.length);
          return "./" + path.join(target, rest);
        }
      }
    }
    return null;
  }

  private tryResolve(resolved: string): string | null {
    // Exact match
    if (this.nodes.has(resolved)) return resolved;

    // Try extensions
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (this.nodes.has(resolved + ext)) return resolved + ext;
    }

    // Try index files
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const indexPath = path.join(resolved, "index" + ext);
      if (this.nodes.has(indexPath)) return indexPath;
    }

    return null;
  }

  private loadPathAliases(): void {
    // Try tsconfig.json first, then jsconfig.json
    for (const configFile of ["tsconfig.json", "jsconfig.json"]) {
      try {
        const configPath = path.join(this.projectRoot, configFile);
        if (!fs.existsSync(configPath)) continue;

        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        const compilerOptions = config.compilerOptions ?? {};

        // Load baseUrl
        if (compilerOptions.baseUrl) {
          this.baseUrl = compilerOptions.baseUrl;
        }

        // Load path aliases
        const paths = compilerOptions.paths ?? {};
        for (const [key, value] of Object.entries(paths)) {
          if (Array.isArray(value) && value.length > 0) {
            this.tsconfigAliases[key] = value[0] as string;
          }
        }

        break; // Use first config found
      } catch {
        // ignore
      }
    }
  }

  // ─── Internal: Component Tree ───

  private buildComponentSubtree(
    name: string,
    filepath: string,
    visited: Set<string>
  ): { name: string; children: any[] } {
    if (visited.has(name)) return { name: `${name} (circular)`, children: [] };
    visited.add(name);

    const children: { name: string; children: any[] }[] = [];

    // Find components rendered by this file (i.e., what does this file import that are components?)
    const deps = this.getDependenciesOf(filepath);
    for (const dep of deps) {
      const depNode = this.nodes.get(dep);
      if (!depNode) continue;

      for (const comp of depNode.components) {
        // Check if this component is actually imported by the file
        const edges = this.edges.get(filepath) ?? [];
        const isImported = edges.some(
          (e) => e.to === dep && e.symbols.includes(comp.name)
        );
        if (isImported) {
          children.push(this.buildComponentSubtree(comp.name, dep, visited));
        }
      }
    }

    return { name, children };
  }
}
