import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { HttpMethod, Schema, ServerFramework, ServerHandler } from "./types.js";
import { parseRouteTemplate } from "./route-template.js";
import {
  buildTypeTable,
  typeNodeToSchema,
  type TypeTable,
  type ExternalResolver,
} from "./ts-type-resolver.js";
import { CrossFileResolver } from "./cross-file-resolver.js";
import { objectExpressionToSchema } from "./ts-value-resolver.js";
import { walkFiles } from "./fs-walk.js";
import { parsePythonServerHandlers } from "./python-parser.js";
import { parseGoServerHandlers } from "./go-parser.js";

const SERVER_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const HTTP_METHOD_NAMES = new Set(["get", "post", "put", "patch", "delete"]);
const RESPONSE_SEND_NAMES = new Set(["json", "send"]);

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function normalizeMethod(text: string): HttpMethod {
  const upper = text.toUpperCase();
  const valid: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  return (valid as string[]).includes(upper) ? (upper as HttpMethod) : "UNKNOWN";
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

function detectFramework(text: string): ServerFramework {
  if (/from\s+["']fastify["']|require\(["']fastify["']\)/.test(text)) return "fastify";
  if (/from\s+["']express["']|require\(["']express["']\)/.test(text)) return "express";
  if (/next\/server|NextResponse/.test(text)) return "nextjs";
  return "express";
}

/** Finds the response-producing call inside a handler function body:
 *  `res.json(x)`, `res.send(x)`, `res.status(n).json(x)`, `reply.send(x)`,
 *  `reply.code(n).send(x)`, or (fastify shorthand) a bare `return x;`
 *  where `x` is an object/array literal. Returns the first one found via a
 *  straightforward pre-order traversal — good enough for the common case
 *  of a single success-path response per handler. */
function findResponseExpression(body: ts.Node): ts.Expression | null {
  let found: ts.Expression | null = null;

  function visit(node: ts.Node): void {
    if (found) return;

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (RESPONSE_SEND_NAMES.has(methodName) && node.arguments[0]) {
        const receiverText = node.expression.expression.getText();
        if (/^(res|reply|response)(\.|$)/.test(receiverText) || receiverText === "res" || receiverText === "reply") {
          found = node.arguments[0];
          return;
        }
      }
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      (ts.isObjectLiteralExpression(node.expression) || ts.isArrayLiteralExpression(node.expression))
    ) {
      found = node.expression;
      return;
    }

    ts.forEachChild(node, visit);
  }
  visit(body);
  return found;
}

function extractReturnTypeSchema(
  fn: ts.FunctionLikeDeclarationBase,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  if (!fn.type) return null;
  if (ts.isTypeReferenceNode(fn.type) && fn.type.typeArguments?.[0]) {
    // Unwrap Promise<T>
    return typeNodeToSchema(fn.type.typeArguments[0], table, undefined, resolveExternal);
  }
  return typeNodeToSchema(fn.type, table, undefined, resolveExternal);
}

function resolveHandlerFunction(
  arg: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.FunctionLikeDeclarationBase | null {
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
  if (ts.isIdentifier(arg)) {
    // Best-effort lookup of a named function declared in the same file.
    let found: ts.FunctionLikeDeclarationBase | null = null;
    ts.forEachChild(sourceFile, function search(node) {
      if (found) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === arg.text) {
        found = node;
        return;
      }
      ts.forEachChild(node, search);
    });
    return found;
  }
  return null;
}

/** Resolves `res.json(someVariable)` (a bare identifier, as opposed to an
 *  inline object literal) by walking the handler body for the nearest
 *  `const`/`let` declaration of that name and resolving *that*: its type
 *  annotation if present, its object-literal initializer if not, or one
 *  hop through an `as`/angle-bracket type assertion. This deliberately
 *  mirrors the one-hop philosophy used elsewhere (see ts-type-resolver.ts):
 *  if the initializer is itself just another identifier (e.g. a value
 *  imported from another module, or built up across several reassignments),
 *  that degrades to "unverifiable" rather than chasing an unbounded
 *  data-flow graph. */
function resolveIdentifierSchema(
  ident: ts.Identifier,
  scope: ts.Node,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const name = ident.text;
  let found: ts.VariableDeclaration | null = null;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  if (!found) return null;

  const decl = found as ts.VariableDeclaration;
  if (decl.type) {
    return typeNodeToSchema(decl.type, table, undefined, resolveExternal);
  }
  if (decl.initializer) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) {
      return typeNodeToSchema(init.type, table, undefined, resolveExternal);
    }
    if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
      return objectExpressionToSchema(init);
    }
  }
  return null;
}

/** Resolves a response expression (an object/array literal, or a bare
 *  identifier referencing one) to a schema. Shared by every framework's
 *  handler-body scanning so identifier resolution ("res.json(payload)"
 *  where `payload` is declared elsewhere) works uniformly instead of only
 *  being wired up for some frameworks and not others. */
function resolveResponseExpressionSchema(
  responseExpr: ts.Expression,
  containingBody: ts.Node,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const direct = objectExpressionToSchema(responseExpr);
  if (direct) return direct;
  if (ts.isIdentifier(responseExpr)) {
    return resolveIdentifierSchema(responseExpr, containingBody, table, resolveExternal);
  }
  return null;
}

function schemaFromHandler(
  fn: ts.FunctionLikeDeclarationBase,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const fromReturnType = extractReturnTypeSchema(fn, table, resolveExternal);
  if (fromReturnType) return fromReturnType;
  if (!fn.body) return null;
  const responseExpr = findResponseExpression(fn.body);
  if (!responseExpr) return null;
  return resolveResponseExpressionSchema(responseExpr, fn.body, table, resolveExternal);
}

function parseExpressLikeSourceFile(
  filePath: string,
  text: string,
  resolver: CrossFileResolver = new CrossFileResolver(),
): ServerHandler[] {
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : filePath.endsWith(".js")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const table = buildTypeTable(sourceFile);
  const resolveExternal: ExternalResolver = (name) =>
    resolver.resolveImportedType(name, filePath, sourceFile);
  const framework = detectFramework(text);
  const handlers: ServerHandler[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text.toLowerCase();
      if (HTTP_METHOD_NAMES.has(methodName)) {
        const pathArg = node.arguments[0];
        const handlerArg = node.arguments[node.arguments.length - 1];
        if (pathArg && handlerArg && (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg))) {
          const fn = resolveHandlerFunction(handlerArg, sourceFile);
          const schema = fn ? schemaFromHandler(fn, table, resolveExternal) : null;
          const loc = locationOf(sourceFile, node);
          handlers.push({
            id: nextId("ts-server"),
            method: normalizeMethod(methodName),
            route: parseRouteTemplate(pathArg.text),
            responseSchema: schema,
            framework,
            location: { file: filePath, line: loc.line, column: loc.column },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  handlers.push(...parseNextAppRouterFile(filePath, sourceFile, table, resolveExternal));
  handlers.push(...parseNextPagesApiFile(filePath, sourceFile, table, resolveExternal));

  return handlers;
}

const NEXT_METHOD_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Next.js App Router: `app/api/.../route.ts` exporting `GET`/`POST`/etc. */
function parseNextAppRouterFile(
  filePath: string,
  sourceFile: ts.SourceFile,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): ServerHandler[] {
  const base = path.basename(filePath);
  if (!/^route\.(ts|js|tsx|jsx)$/.test(base)) return [];
  const routePath = nextAppRouteFromPath(filePath);
  if (!routePath) return [];

  const handlers: ServerHandler[] = [];
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      NEXT_METHOD_EXPORTS.has(stmt.name.text) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const schema = schemaFromHandler(stmt, table, resolveExternal);
      const loc = locationOf(sourceFile, stmt);
      handlers.push({
        id: nextId("ts-server"),
        method: normalizeMethod(stmt.name.text),
        route: parseRouteTemplate(routePath),
        responseSchema: schema,
        framework: "nextjs",
        location: { file: filePath, line: loc.line, column: loc.column },
      });
    }
  }
  return handlers;
}

function nextAppRouteFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/app/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return null;
  let routeDir = normalized.slice(idx + marker.length);
  routeDir = routeDir.replace(/\/route\.(ts|js|tsx|jsx)$/, "");
  const segments = routeDir
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      const dynamic = seg.match(/^\[(\w+)\]$/);
      return dynamic ? `:${dynamic[1]}` : seg;
    });
  return "/" + segments.join("/");
}

/** Next.js Pages Router: `pages/api/....ts` default-exporting `(req, res) => {}`. */
function parseNextPagesApiFile(
  filePath: string,
  sourceFile: ts.SourceFile,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): ServerHandler[] {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/pages/api/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return [];

  let routeDir = normalized.slice(idx + marker.length).replace(/\.(ts|js|tsx|jsx)$/, "");
  routeDir = routeDir.replace(/\/index$/, "");
  const segments = routeDir
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      const dynamic = seg.match(/^\[(\w+)\]$/);
      return dynamic ? `:${dynamic[1]}` : seg;
    });
  const routePath = "/api/" + segments.join("/");

  let defaultFn: ts.FunctionLikeDeclarationBase | null = null;
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      defaultFn = stmt;
    }
    if (ts.isExportAssignment(stmt) && (ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression))) {
      defaultFn = stmt.expression;
    }
  }
  if (!defaultFn || !defaultFn.body) return [];

  // See resolveNextApiResponseGenericSchema's doc comment: when the handler
  // declares `res: NextApiResponse<T>`, T wins over whatever's inferred
  // from the res.json(...)/res.send(...) call-site expression, the same
  // response_model-over-return-annotation priority already applied on the
  // FastAPI side.
  const declaredResponseSchema = resolveNextApiResponseGenericSchema(defaultFn, table, resolveExternal);

  // Look for `if (req.method === 'POST') { ... }` branches to split by
  // method; fall back to a single GET handler if none are found.
  const branches: { method: HttpMethod; expr: ts.Expression | null; loc: ts.Node }[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIfStatement(node) && isReqMethodCheck(node.expression)) {
      const method = extractMethodFromCheck(node.expression);
      if (method) {
        branches.push({ method, expr: findResponseExpression(node.thenStatement), loc: node });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(defaultFn.body);

  if (branches.length === 0) {
    const expr = findResponseExpression(defaultFn.body);
    const loc = locationOf(sourceFile, defaultFn);
    return [
      {
        id: nextId("ts-server"),
        method: "GET",
        route: parseRouteTemplate(routePath),
        responseSchema:
          declaredResponseSchema ??
          (expr ? resolveResponseExpressionSchema(expr, defaultFn.body, table, resolveExternal) : null),
        framework: "nextjs",
        location: { file: filePath, line: loc.line, column: loc.column },
      },
    ];
  }

  return branches.map((b) => {
    const loc = locationOf(sourceFile, b.loc);
    return {
      id: nextId("ts-server"),
      method: b.method,
      route: parseRouteTemplate(routePath),
      responseSchema:
        declaredResponseSchema ??
        (b.expr ? resolveResponseExpressionSchema(b.expr, defaultFn.body as ts.Node, table, resolveExternal) : null),
      framework: "nextjs" as const,
      location: { file: filePath, line: loc.line, column: loc.column },
    };
  });
}

/** Resolves the `T` in a `res: NextApiResponse<T>` parameter annotation on
 *  a Pages Router handler, when present and non-trivial.
 *
 *  Mirrors the FastAPI `response_model=` priority rule (see
 *  python-parser.ts): the declared response-type generic is the contract
 *  Next.js/TypeScript actually holds the handler to (a mismatched
 *  `res.json(...)` call is a type error at compile time), so when it's
 *  present it should win over inferring the shape from whatever expression
 *  happens to be passed to `res.json(...)` at the call site. This is a new
 *  resolution capability that is outside the current parser boundary, not a
 *  regression fix — it was previously unimplemented, so every Pages Router
 *  handler fell back to inferring its response schema purely from the
 *  `res.json(...)` call-site expression, even when a more authoritative
 *  generic parameter was sitting right there on the handler signature. */
function resolveNextApiResponseGenericSchema(
  fn: ts.FunctionLikeDeclarationBase,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const resParam = fn.parameters[1];
  if (!resParam || !resParam.type) return null;
  if (!ts.isTypeReferenceNode(resParam.type)) return null;

  // Accept both the bare import (`NextApiResponse`) and a namespaced
  // reference (`next.NextApiResponse`) — only the final identifier matters
  // since the type isn't resolved through an import graph.
  const typeNameText = resParam.type.typeName.getText();
  const simpleName = typeNameText.split(".").pop();
  if (simpleName !== "NextApiResponse") return null;

  const typeArg = resParam.type.typeArguments?.[0];
  if (!typeArg) return null;
  // `NextApiResponse` (no generic) and `NextApiResponse<any>` both mean
  // "no declared contract" — nothing to prefer over call-site inference.
  if (typeArg.kind === ts.SyntaxKind.AnyKeyword) return null;

  return typeNodeToSchema(typeArg, table, undefined, resolveExternal);
}

function isReqMethodCheck(expr: ts.Expression): boolean {
  return ts.isBinaryExpression(expr) && /req\.method/.test(expr.left.getText());
}
function extractMethodFromCheck(expr: ts.Expression): HttpMethod | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const right = expr.right;
  if (ts.isStringLiteral(right)) return normalizeMethod(right.text);
  return null;
}

/** Parses every TypeScript/JavaScript server handler under `rootDir`
 *  (Express, Fastify, Next.js Pages & App Router). */
export function parseTsServerHandlers(rootDir: string): ServerHandler[] {
  const files = walkFiles(rootDir, SERVER_EXTENSIONS);
  // One resolver per run, shared across every file — see the matching note
  // in client-parser.ts's parseTsClientCallSites.
  const resolver = new CrossFileResolver();
  const results: ServerHandler[] = [];
  for (const file of files) {
    // See the matching try/catch in client-parser.ts's
    // parseTsClientCallSites for why: a single pathological file can drive
    // the TypeScript parser to a stack overflow, and without this guard
    // that uncaught error kills the whole run and discards every other
    // file's valid results with it.
    try {
      results.push(...parseExpressLikeSourceFile(file, fs.readFileSync(file, "utf8"), resolver));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}

/** Parses a single in-memory source string with no filesystem I/O — used by
 *  unit tests. `filePath` also drives Next.js route inference, so tests
 *  that exercise file-based routing pass a realistic path like
 *  `/repo/pages/api/users/[id].ts`. */
export function parseServerSource(filePath: string, source: string): ServerHandler[] {
  return parseExpressLikeSourceFile(filePath, source);
}

/**
 * Parses every supported server route handler under `rootDir` across all
 * frameworks driftguard understands: Express, Fastify, Next.js
 * (TypeScript/JavaScript AST), FastAPI (Python, real AST via tree-sitter),
 * and Gin (Go, real AST via tree-sitter). See client-parser.ts's
 * `parseClientCallSites` for why only the Python/Go passes are awaited.
 */
export async function parseServerHandlers(rootDir: string): Promise<ServerHandler[]> {
  const [pythonResults, goResults] = await Promise.all([
    parsePythonServerHandlers(rootDir),
    parseGoServerHandlers(rootDir),
  ]);
  return [...parseTsServerHandlers(rootDir), ...pythonResults, ...goResults];
}
