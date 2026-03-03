import {
  parseSync,
  type Module,
  type ModuleItem,
  type Statement,
  type Expression,
  type Pattern,
  type Declaration,
  type TsType,
  type TsParserConfig,
  type EsParserConfig,
} from "@swc/core";
import * as path from "path";
import type {
  Import,
  Export,
  FunctionNode,
  ComponentNode,
  HookUsage,
  ApiCall,
} from "../shared/types";

interface ParseResult {
  imports: Import[];
  exports: Export[];
  functions: FunctionNode[];
  components: ComponentNode[];
  hooks: HookUsage[];
  apiCalls: ApiCall[];
}

/**
 * Parse a source file and extract structural information using SWC.
 */
export function parseFile(content: string, filepath: string): ParseResult {
  const ext = path.extname(filepath);
  const isTs = ext === ".ts" || ext === ".tsx";
  const hasJsx = ext === ".tsx" || ext === ".jsx";

  const parserConfig: TsParserConfig | EsParserConfig = isTs
    ? { syntax: "typescript" as const, tsx: hasJsx }
    : { syntax: "ecmascript" as const, jsx: hasJsx };

  let ast: Module;
  try {
    ast = parseSync(content, {
      syntax: parserConfig,
      target: "es2020",
    });
  } catch {
    return { imports: [], exports: [], functions: [], components: [], hooks: [], apiCalls: [] };
  }

  const imports = extractImports(ast);
  const exports = extractExports(ast);
  const functions = extractFunctions(ast);
  const hooks = extractHooks(ast);
  const apiCalls = extractApiCalls(ast);
  const components = identifyComponents(functions, hooks);

  return { imports, exports, functions, components, hooks, apiCalls };
}

// ─── Import Extraction ───

function extractImports(ast: Module): Import[] {
  const imports: Import[] = [];

  for (const item of ast.body) {
    // import { Foo, Bar } from "module"
    // import Foo from "module"
    // import * as Foo from "module"
    if (item.type === "ImportDeclaration") {
      const source = item.source.value;
      const names: string[] = [];
      let isDefault = false;

      for (const spec of item.specifiers) {
        if (spec.type === "ImportDefaultSpecifier") {
          names.push(spec.local.value);
          isDefault = true;
        } else if (spec.type === "ImportSpecifier") {
          const imported = spec.imported ? spec.imported.value : spec.local.value;
          names.push(imported);
        } else if (spec.type === "ImportNamespaceSpecifier") {
          names.push(spec.local.value);
        }
      }

      imports.push({
        source,
        names,
        isDefault,
        line: getLineFromSpan(item.span.start),
      });
    }

    // const Foo = require("module")
    if (item.type === "VariableDeclaration") {
      for (const decl of item.declarations) {
        if (!decl.init) continue;
        const requireSource = getRequireSource(decl.init);
        if (!requireSource) continue;

        const names: string[] = [];
        let isDefault = false;

        if (decl.id.type === "Identifier") {
          names.push(decl.id.value);
          isDefault = true;
        } else if (decl.id.type === "ObjectPattern") {
          for (const prop of decl.id.properties) {
            if (prop.type === "KeyValuePatternProperty" && prop.key.type === "Identifier") {
              names.push(prop.key.value);
            } else if (prop.type === "AssignmentPatternProperty") {
              names.push(prop.key.value);
            }
          }
        }

        imports.push({
          source: requireSource,
          names,
          isDefault,
          line: getLineFromSpan(item.span.start),
        });
      }
    }
  }

  return imports;
}

/**
 * Check if an expression is `require("...")` and return the source string.
 */
function getRequireSource(expr: Expression): string | null {
  if (
    expr.type === "CallExpression" &&
    expr.callee.type === "Identifier" &&
    expr.callee.value === "require" &&
    expr.arguments.length === 1 &&
    expr.arguments[0].expression.type === "StringLiteral"
  ) {
    return expr.arguments[0].expression.value;
  }
  return null;
}

// ─── Export Extraction ───

function extractExports(ast: Module): Export[] {
  const exports: Export[] = [];

  for (const item of ast.body) {
    // export default ...
    if (item.type === "ExportDefaultDeclaration" || item.type === "ExportDefaultExpression") {
      exports.push({
        name: "default",
        type: "default",
        line: getLineFromSpan(item.span.start),
      });
      continue;
    }

    // export { Foo, Bar } — re-export specifiers
    if (item.type === "ExportNamedDeclaration") {
      for (const spec of item.specifiers) {
        if (spec.type === "ExportSpecifier") {
          const name = spec.exported
            ? (spec.exported.type === "Identifier" ? spec.exported.value : spec.exported.value)
            : spec.orig.value;
          exports.push({
            name,
            type: "constant",
            line: getLineFromSpan(item.span.start),
          });
        }
      }
    }

    // export function/const/class/type/interface
    if (item.type === "ExportDeclaration") {
      pushDeclExports(item.declaration, exports);
    }
  }

  return exports;
}

function pushDeclExports(decl: Declaration, exports: Export[]): void {
  if (decl.type === "FunctionDeclaration") {
    const name = decl.identifier.value;
    const isComponent = name[0] >= "A" && name[0] <= "Z";
    exports.push({
      name,
      type: isComponent ? "component" : "function",
      line: getLineFromSpan(decl.span.start),
    });
  } else if (decl.type === "ClassDeclaration") {
    exports.push({
      name: decl.identifier.value,
      type: "function",
      line: getLineFromSpan(decl.span.start),
    });
  } else if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier") {
        const name = d.id.value;
        const isComponent = name[0] >= "A" && name[0] <= "Z";
        const isFunction =
          d.init?.type === "ArrowFunctionExpression" ||
          d.init?.type === "FunctionExpression";
        exports.push({
          name,
          type: isComponent && isFunction ? "component" : isFunction ? "function" : "constant",
          line: getLineFromSpan(decl.span.start),
        });
      }
    }
  } else if (decl.type === "TsInterfaceDeclaration") {
    exports.push({
      name: decl.id.value,
      type: "type",
      line: getLineFromSpan(decl.span.start),
    });
  } else if (decl.type === "TsTypeAliasDeclaration") {
    exports.push({
      name: decl.id.value,
      type: "type",
      line: getLineFromSpan(decl.span.start),
    });
  }
}

// ─── Function Extraction ───

function extractFunctions(ast: Module): FunctionNode[] {
  const functions: FunctionNode[] = [];
  collectFunctions(ast.body, functions);
  return functions;
}

function collectFunctions(items: (ModuleItem | Statement)[], functions: FunctionNode[]): void {
  for (const item of items) {
    // function foo() {}
    if (item.type === "FunctionDeclaration") {
      functions.push({
        name: item.identifier.value,
        params: extractParamNames(item.params.map((p) => p.pat)),
        returnType: item.returnType ? stringifyTsType(item.returnType.typeAnnotation) : undefined,
        line: getLineFromSpan(item.span.start),
        endLine: getLineFromSpan(item.span.end),
      });
    }

    // export function foo() {} / export class Foo {}
    if (item.type === "ExportDeclaration") {
      const decl = item.declaration;
      if (decl.type === "FunctionDeclaration") {
        functions.push({
          name: decl.identifier.value,
          params: extractParamNames(decl.params.map((p) => p.pat)),
          returnType: decl.returnType ? stringifyTsType(decl.returnType.typeAnnotation) : undefined,
          line: getLineFromSpan(decl.span.start),
          endLine: getLineFromSpan(decl.span.end),
        });
      } else if (decl.type === "VariableDeclaration") {
        extractVarFunctions(decl, functions);
      }
    }

    // export default function foo() {}
    if (item.type === "ExportDefaultDeclaration" && item.decl.type === "FunctionExpression") {
      const decl = item.decl;
      functions.push({
        name: decl.identifier?.value ?? "default",
        params: extractParamNames(decl.params.map((p) => p.pat)),
        returnType: decl.returnType ? stringifyTsType(decl.returnType.typeAnnotation) : undefined,
        line: getLineFromSpan(decl.span.start),
        endLine: getLineFromSpan(decl.span.end),
      });
    }

    // const foo = () => {} or const foo = function() {}
    if (item.type === "VariableDeclaration") {
      extractVarFunctions(item, functions);
    }
  }
}

function extractVarFunctions(varDecl: { declarations: any[] }, functions: FunctionNode[]): void {
  for (const decl of varDecl.declarations) {
    if (decl.id.type !== "Identifier") continue;
    const init = decl.init;
    if (!init) continue;

    if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
      functions.push({
        name: decl.id.value,
        params: extractParamNames(init.params.map((p: any) => p.pat ?? p)),
        returnType: init.returnType ? stringifyTsType(init.returnType.typeAnnotation) : undefined,
        line: getLineFromSpan(decl.span.start),
        endLine: getLineFromSpan(init.span.end),
      });
    }
  }
}

function extractParamNames(params: Pattern[]): string[] {
  const names: string[] = [];
  for (const p of params) {
    if (p.type === "Identifier") {
      names.push(p.value);
    } else if (p.type === "ObjectPattern") {
      for (const prop of p.properties) {
        if (prop.type === "KeyValuePatternProperty" && prop.key.type === "Identifier") {
          names.push(prop.key.value);
        } else if (prop.type === "AssignmentPatternProperty") {
          names.push(prop.key.value);
        }
      }
    } else if (p.type === "ArrayPattern") {
      names.push("...");
    } else if (p.type === "RestElement" && p.argument.type === "Identifier") {
      names.push(`...${p.argument.value}`);
    } else if (p.type === "AssignmentPattern" && p.left.type === "Identifier") {
      names.push(p.left.value);
    }
  }
  return names;
}

function stringifyTsType(t: TsType): string {
  if (t.type === "TsKeywordType") return t.kind;
  if (t.type === "TsTypeReference" && t.typeName.type === "Identifier") return t.typeName.value;
  if (t.type === "TsArrayType") return `${stringifyTsType(t.elemType)}[]`;
  return "unknown";
}

// ─── Hook Extraction ───

function extractHooks(ast: Module): HookUsage[] {
  const hooks: HookUsage[] = [];
  walkExpressions(ast.body, (expr) => {
    if (
      expr.type === "CallExpression" &&
      expr.callee.type === "Identifier" &&
      expr.callee.value.startsWith("use") &&
      expr.callee.value.length > 3 &&
      expr.callee.value[3] === expr.callee.value[3].toUpperCase()
    ) {
      hooks.push({
        name: expr.callee.value,
        line: getLineFromSpan(expr.span.start),
      });
    }
  });
  return hooks;
}

// ─── API Call Extraction ───

function extractApiCalls(ast: Module): ApiCall[] {
  const calls: ApiCall[] = [];
  walkExpressions(ast.body, (expr) => {
    if (expr.type !== "CallExpression") return;

    // fetch("url", ...)
    if (expr.callee.type === "Identifier" && expr.callee.value === "fetch") {
      const firstArg = expr.arguments[0]?.expression;
      const endpoint = firstArg && firstArg.type === "StringLiteral" ? firstArg.value : undefined;

      let method = "GET";
      const optionsArg = expr.arguments[1]?.expression;
      if (optionsArg && optionsArg.type === "ObjectExpression") {
        for (const prop of optionsArg.properties) {
          if (
            prop.type === "KeyValueProperty" &&
            prop.key.type === "Identifier" &&
            prop.key.value === "method" &&
            prop.value.type === "StringLiteral"
          ) {
            method = prop.value.value.toUpperCase();
          }
        }
      }

      calls.push({ method, endpoint, line: getLineFromSpan(expr.span.start) });
    }

    // axios.get("url"), axios.post("url"), etc.
    if (
      expr.callee.type === "MemberExpression" &&
      expr.callee.object.type === "Identifier" &&
      expr.callee.object.value === "axios" &&
      expr.callee.property.type === "Identifier"
    ) {
      const method = expr.callee.property.value.toUpperCase();
      const firstArg = expr.arguments[0]?.expression;
      const endpoint = firstArg && firstArg.type === "StringLiteral" ? firstArg.value : undefined;
      calls.push({ method, endpoint, line: getLineFromSpan(expr.span.start) });
    }
  });
  return calls;
}

// ─── Component Identification ───

function identifyComponents(functions: FunctionNode[], hooks: HookUsage[]): ComponentNode[] {
  const components: ComponentNode[] = [];
  const hookNames = hooks.map((h) => h.name);

  for (const fn of functions) {
    if (fn.name[0] >= "A" && fn.name[0] <= "Z") {
      components.push({
        name: fn.name,
        props: fn.params,
        hooks: hookNames,
        line: fn.line,
        endLine: fn.endLine,
      });
    }
  }

  return components;
}

// ─── AST Walking Helpers ───

function walkExpressions(items: (ModuleItem | Statement)[], callback: (expr: Expression) => void): void {
  for (const item of items) {
    walkNode(item, callback);
  }
}

function walkNode(node: any, callback: (expr: Expression) => void): void {
  if (!node || typeof node !== "object") return;

  if (node.type && isExpressionType(node.type)) {
    callback(node as Expression);
  }

  // Recurse into child structures
  const keys = [
    "body", "stmts", "declarations", "declaration", "decl", "init",
    "expression", "callee", "arguments", "consequent", "alternate",
    "block", "handler", "finalizer", "left", "right", "test", "update",
    "object", "argument", "params", "elements", "properties", "value",
  ];

  for (const key of keys) {
    const child = node[key];
    if (!child) continue;

    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object") walkNode(item, callback);
      }
    } else if (typeof child === "object" && child.type) {
      walkNode(child, callback);
    }
  }

  // Handle property specifically (can be Identifier or Computed)
  if (node.property && typeof node.property === "object" && node.property.type) {
    walkNode(node.property, callback);
  }
}

function isExpressionType(type: string): boolean {
  return type.endsWith("Expression") || type === "CallExpression" || type === "StringLiteral";
}

// ─── Line Number Helpers ───

function getLineFromSpan(offset: number): number {
  // SWC byte offsets — we store them as-is for now.
  // The actual line number calculation would require the source text,
  // but byte offsets are still useful for ordering and comparison.
  return offset > 0 ? offset : 0;
}
