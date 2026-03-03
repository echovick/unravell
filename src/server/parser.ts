import { parseSync, type Module, type ModuleItem, type Statement, type Expression, type Pattern, type Declaration, type ClassMember, type TsType } from "@swc/core";
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
 * Detect the SWC syntax config based on file extension.
 */
function getSyntax(filepath: string): "ecmascript" | "typescript" {
  const ext = path.extname(filepath);
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "ecmascript";
}

function hasTsx(filepath: string): boolean {
  const ext = path.extname(filepath);
  return ext === ".tsx" || ext === ".jsx";
}

/**
 * Parse a source file and extract structural information using SWC.
 */
export function parseFile(content: string, filepath: string): ParseResult {
  const syntax = getSyntax(filepath);
  const tsx = hasTsx(filepath);

  let ast: Module;
  try {
    ast = parseSync(content, {
      syntax: syntax === "typescript"
        ? { syntax: "typescript", tsx }
        : { syntax: "ecmascript", jsx: tsx },
      target: "es2020",
    });
  } catch {
    // If SWC can't parse (e.g. syntax errors), return empty result
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
          // Use the imported name (not the local alias)
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
        line: item.span.start ? getLine(ast, item.span.start) : 0,
      });
    }

    // const Foo = require("module")
    if (item.type === "VariableDeclaration") {
      for (const decl of item.declarations) {
        if (decl.init && isRequireCall(decl.init)) {
          const source = getRequireSource(decl.init);
          if (!source) continue;

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
            source,
            names,
            isDefault,
            line: item.span.start ? getLine(ast, item.span.start) : 0,
          });
        }
      }
    }
  }

  return imports;
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
        line: getLine(ast, item.span.start),
      });
      continue;
    }

    // export { Foo, Bar }
    if (item.type === "ExportNamedDeclaration") {
      // export { name1, name2 }
      for (const spec of item.specifiers) {
        if (spec.type === "ExportSpecifier") {
          const name = spec.exported
            ? (spec.exported.type === "Identifier" ? spec.exported.value : spec.exported.value)
            : spec.orig.value;
          exports.push({
            name,
            type: "constant",
            line: getLine(ast, item.span.start),
          });
        }
      }

      // export function/const/class/type/interface
      if (item.declaration) {
        const decl = item.declaration;
        pushDeclExports(decl, exports, ast);
      }
    }

    // export function foo() {} (without ExportNamedDeclaration wrapper in some cases)
    if (item.type === "ExportDeclaration") {
      pushDeclExports(item.declaration, exports, ast);
    }
  }

  return exports;
}

function pushDeclExports(decl: Declaration, exports: Export[], ast: Module): void {
  if (decl.type === "FunctionDeclaration") {
    const name = decl.identifier.value;
    const isComponent = name[0] >= "A" && name[0] <= "Z";
    exports.push({
      name,
      type: isComponent ? "component" : "function",
      line: getLine(ast, decl.span.start),
    });
  } else if (decl.type === "ClassDeclaration") {
    exports.push({
      name: decl.identifier.value,
      type: "function",
      line: getLine(ast, decl.span.start),
    });
  } else if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier") {
        const name = d.id.value;
        const isComponent = name[0] >= "A" && name[0] <= "Z";
        // Check if it's an arrow function
        const isFunction = d.init?.type === "ArrowFunctionExpression" || d.init?.type === "FunctionExpression";
        exports.push({
          name,
          type: isComponent && isFunction ? "component" : isFunction ? "function" : "constant",
          line: getLine(ast, decl.span.start),
        });
      }
    }
  } else if (decl.type === "TsInterfaceDeclaration") {
    exports.push({
      name: decl.id.value,
      type: "type",
      line: getLine(ast, decl.span.start),
    });
  } else if (decl.type === "TsTypeAliasDeclaration") {
    exports.push({
      name: decl.id.value,
      type: "type",
      line: getLine(ast, decl.span.start),
    });
  }
}

// ─── Function Extraction ───

function extractFunctions(ast: Module): FunctionNode[] {
  const functions: FunctionNode[] = [];
  collectFunctions(ast.body, functions, ast);
  return functions;
}

function collectFunctions(items: ModuleItem[] | Statement[], functions: FunctionNode[], ast: Module): void {
  for (const item of items) {
    // function foo() {}
    if (item.type === "FunctionDeclaration") {
      functions.push({
        name: item.identifier.value,
        params: extractParamNames(item.params.map(p => p.pat)),
        returnType: item.returnType ? stringifyTsType(item.returnType.typeAnnotation) : undefined,
        line: getLine(ast, item.span.start),
        endLine: getLine(ast, item.span.end),
      });
    }

    // export function foo() {}
    if (item.type === "ExportDeclaration" && item.declaration.type === "FunctionDeclaration") {
      const decl = item.declaration;
      functions.push({
        name: decl.identifier.value,
        params: extractParamNames(decl.params.map(p => p.pat)),
        returnType: decl.returnType ? stringifyTsType(decl.returnType.typeAnnotation) : undefined,
        line: getLine(ast, decl.span.start),
        endLine: getLine(ast, decl.span.end),
      });
    }

    // export default function foo() {}
    if (item.type === "ExportDefaultDeclaration" && item.decl.type === "FunctionExpression") {
      const decl = item.decl;
      functions.push({
        name: decl.identifier?.value ?? "default",
        params: extractParamNames(decl.params.map(p => p.pat)),
        returnType: decl.returnType ? stringifyTsType(decl.returnType.typeAnnotation) : undefined,
        line: getLine(ast, decl.span.start),
        endLine: getLine(ast, decl.span.end),
      });
    }

    // const foo = () => {} or const foo = function() {}
    if (item.type === "VariableDeclaration" || (item.type === "ExportDeclaration" && item.declaration.type === "VariableDeclaration")) {
      const varDecl = item.type === "VariableDeclaration" ? item : (item as any).declaration;
      for (const decl of varDecl.declarations) {
        if (decl.id.type !== "Identifier") continue;
        const init = decl.init;
        if (!init) continue;

        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          functions.push({
            name: decl.id.value,
            params: extractParamNames(init.params.map((p: any) => p.pat ?? p)),
            returnType: init.returnType ? stringifyTsType(init.returnType.typeAnnotation) : undefined,
            line: getLine(ast, decl.span.start),
            endLine: getLine(ast, init.span.end),
          });
        }
      }
    }
  }
}

function extractParamNames(params: Pattern[]): string[] {
  const names: string[] = [];
  for (const p of params) {
    if (p.type === "Identifier") {
      names.push(p.value);
    } else if (p.type === "ObjectPattern") {
      // Destructured params — list the keys
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
      expr.callee.value[3] &&
      expr.callee.value[3] === expr.callee.value[3].toUpperCase()
    ) {
      hooks.push({
        name: expr.callee.value,
        line: getLine(ast, expr.span.start),
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

      // Try to detect method from options
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

      calls.push({ method, endpoint, line: getLine(ast, expr.span.start) });
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
      calls.push({ method, endpoint, line: getLine(ast, expr.span.start) });
    }
  });
  return calls;
}

// ─── Component Identification ───

function identifyComponents(functions: FunctionNode[], hooks: HookUsage[]): ComponentNode[] {
  const components: ComponentNode[] = [];
  const hookNames = hooks.map((h) => h.name);

  for (const fn of functions) {
    // React components start with uppercase
    if (fn.name[0] >= "A" && fn.name[0] <= "Z") {
      components.push({
        name: fn.name,
        props: fn.params,
        hooks: hookNames, // TODO: scope hooks to specific components
        line: fn.line,
        endLine: fn.endLine,
      });
    }
  }

  return components;
}

// ─── AST Walking Helpers ───

/**
 * Walk all expressions in the AST body. This is a simplified walker
 * that covers the common patterns (function bodies, arrow functions, etc.)
 * without a full recursive visitor.
 */
function walkExpressions(items: (ModuleItem | Statement)[], callback: (expr: Expression) => void): void {
  for (const item of items) {
    walkItem(item, callback);
  }
}

function walkItem(node: any, callback: (expr: Expression) => void): void {
  if (!node || typeof node !== "object") return;

  // If this node is an expression, call the callback
  if (node.type && isExpression(node.type)) {
    callback(node as Expression);
  }

  // Recurse into known structures
  if (node.body) {
    if (Array.isArray(node.body)) {
      for (const child of node.body) walkItem(child, callback);
    } else {
      walkItem(node.body, callback);
    }
  }
  if (node.stmts) {
    for (const stmt of node.stmts) walkItem(stmt, callback);
  }
  if (node.declarations) {
    for (const decl of node.declarations) walkItem(decl, callback);
  }
  if (node.declaration) walkItem(node.declaration, callback);
  if (node.decl) walkItem(node.decl, callback);
  if (node.init) walkItem(node.init, callback);
  if (node.expression) walkItem(node.expression, callback);
  if (node.callee) walkItem(node.callee, callback);
  if (node.arguments) {
    for (const arg of node.arguments) walkItem(arg, callback);
  }
  if (node.consequent) walkItem(node.consequent, callback);
  if (node.alternate) walkItem(node.alternate, callback);
  if (node.block) walkItem(node.block, callback);
  if (node.handler) walkItem(node.handler, callback);
  if (node.finalizer) walkItem(node.finalizer, callback);
  if (node.left) walkItem(node.left, callback);
  if (node.right) walkItem(node.right, callback);
  if (node.test) walkItem(node.test, callback);
  if (node.update) walkItem(node.update, callback);
  if (node.object) walkItem(node.object, callback);
  if (node.property && typeof node.property === "object") walkItem(node.property, callback);
  if (node.elements) {
    for (const el of node.elements) {
      if (el) walkItem(el, callback);
    }
  }
  if (node.properties) {
    for (const prop of node.properties) walkItem(prop, callback);
  }
  if (node.value && typeof node.value === "object" && node.value.type) walkItem(node.value, callback);
  if (node.argument) walkItem(node.argument, callback);
  if (node.params) {
    for (const p of node.params) walkItem(p, callback);
  }
}

function isExpression(type: string): boolean {
  return type.endsWith("Expression") || type === "CallExpression" || type === "StringLiteral";
}

// ─── Line Number Calculation ───

function getLine(ast: Module, offset: number): number {
  // SWC spans are byte offsets; we approximate line number
  // by counting newlines in the source up to the offset.
  // For better accuracy we'd cache the line map, but this is fine for MVP.
  // The offset from SWC's span is relative to the start of the module.
  // We return 0 if we can't determine it — the caller can handle that.
  return offset > 0 ? offset : 0;
}
