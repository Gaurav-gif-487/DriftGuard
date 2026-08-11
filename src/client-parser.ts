import fs from "node:fs";
import ts from "typescript";
import type { ClientCallSite, ClientFramework, HttpMethod, Schema } from "./types.js";
import { parseRouteTemplate } from "./route-template.js";
import {
  buildTypeTable,
  typeNodeToSchema,
  bindingPatternToSchema,
  type TypeTable,
  type ExternalResolver,
} from "./ts-type-resolver.js";
import { CrossFileResolver } from "./cross-file-resolver.js";
import { walkFiles } from "./fs-walk.js";
import { parsePythonClientCallSites } from "./python-parser.js";
import { parseGoClientCallSites } from "./go-parser.js";

const HTTP_METHOD_NAMES = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

const CLIENT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

interface PathExtraction {
  raw: string;
  dynamic: boolean;
}

/** Reconstructs a path string from a string literal, template literal, or
 *  `+`-concatenation expression. Any interpolated/non-literal segment is
 *  replaced with the `__DYN__` placeholder token that `route-template.ts`
 *  recognizes, and `dynamic` is set so the route matcher knows to fall back
 *  to fuzzy resolution instead of exact matching. */
/** Finds a top-level (module-scope) `const <name> = <expr>` in `sourceFile`
 *  and returns its initializer, or null. Deliberately scoped to module
 *  level only: a function-local `const` that merely happens to share a
 *  name isn't what we're resolving here, and a value captured from a
 *  parameter/DI container is legitimately dynamic, not this pattern. */
function findLocalConstInitializer(name: string, sourceFile: ts.SourceFile): ts.Expression | null {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        return decl.initializer;
      }
    }
  }
  return null;
}

/** Resolves `name` (as referenced in `sourceFile`) back through a `const`
 *  binding: first a same-file declaration, then — only if none exists
 *  locally — at most one import hop via `resolver`, mirroring
 *  `CrossFileResolver`'s existing one-hop scope elsewhere in this tool.
 *  Returns both the resolved expression *and* the hop budget remaining
 *  after whatever hop this step itself consumed, so a caller chaining a
 *  further identifier resolution off the result (e.g. a property of an
 *  imported object literal that is itself another imported identifier)
 *  can't accidentally spend a second hop it was never granted — the
 *  earlier version of this resolver had exactly that bug: it always
 *  called back into the same fixed budget the *outermost* call started
 *  with, so a two-hop chain (`const config = { apiBase: X }` importing X
 *  from a third file) silently resolved when it should have stayed
 *  `__DYN__`, caught by a regression test asserting the one-hop boundary. */
function resolveIdentifierBinding(
  name: string,
  sourceFile: ts.SourceFile,
  resolver: CrossFileResolver | undefined,
  hopsRemaining: number,
): { expr: ts.Expression; hopsRemaining: number } | null {
  const local = findLocalConstInitializer(name, sourceFile);
  if (local) return { expr: local, hopsRemaining };

  if (hopsRemaining > 0 && resolver && sourceFile.fileName) {
    const imported = resolver.resolveImportedConstInitializer(name, sourceFile.fileName, sourceFile);
    if (imported) return { expr: imported, hopsRemaining: hopsRemaining - 1 };
  }
  return null;
}

/** Resolves `x` in a property access `x.y` down to the `const` object
 *  literal it's provably bound to — same file, or one import hop away.
 *  Returns the object literal together with the hop budget remaining
 *  after resolving it, so `resolveConstLiteralValue`'s property-access
 *  branch can correctly pass that (possibly already-exhausted) budget
 *  along when resolving the property's own value, instead of a stale one. */
function resolveConstObjectLiteral(
  expr: ts.Expression,
  resolver?: CrossFileResolver,
  hopsRemaining = 1,
): { obj: ts.ObjectLiteralExpression; hopsRemaining: number } | null {
  if (ts.isObjectLiteralExpression(expr)) return { obj: expr, hopsRemaining };
  if (!ts.isIdentifier(expr)) return null;

  const sourceFile = expr.getSourceFile();
  if (!sourceFile) return null;
  const resolved = resolveIdentifierBinding(expr.text, sourceFile, resolver, hopsRemaining);
  if (!resolved) return null;
  return resolveConstObjectLiteral(resolved.expr, resolver, resolved.hopsRemaining);
}

/** Resolves an expression used inside a template-literal interpolation span
 *  (the `x` in `` `${x}/articles` ``) to a literal string value, when doing
 *  so is provably safe: it traces back to a `const` string literal, or a
 *  `const` object literal's string-literal property, either in the same
 *  file or one import hop away. Anything reassignable (`let`/`var`), any
 *  function call, and anything needing a second import hop or runtime DI
 *  wiring is left unresolved (`null`) rather than guessed at — the caller
 *  falls back to the existing `__DYN__` behavior for those, unchanged.
 *
 *  Found while running against a real fullstack repo (a RealWorld-spec
 *  client/server pair) where every single client call site built its URL
 *  as `` `${this.config.apiBase}/articles` ``, with `apiBase` a literal
 *  string in a sibling `config.ts` — previously every one of those
 *  collapsed to a fully-dynamic `__DYN__` path and lost route matching
 *  entirely, not because the value was actually unknowable, but because no
 *  attempt was ever made to look. */
function resolveConstLiteralValue(
  expr: ts.Expression,
  resolver?: CrossFileResolver,
  hopsRemaining = 1,
): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const objLiteral = resolveConstObjectLiteral(expr.expression, resolver, hopsRemaining);
    if (!objLiteral) return null;
    const prop = findObjectLiteralProp(objLiteral.obj, expr.name.text);
    if (!prop) return null;
    return resolveConstLiteralValue(prop, resolver, objLiteral.hopsRemaining);
  }

  if (ts.isIdentifier(expr)) {
    const sourceFile = expr.getSourceFile();
    if (!sourceFile) return null;
    const resolved = resolveIdentifierBinding(expr.text, sourceFile, resolver, hopsRemaining);
    if (!resolved) return null;
    return resolveConstLiteralValue(resolved.expr, resolver, resolved.hopsRemaining);
  }

  return null;
}

function extractPathExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  resolver?: CrossFileResolver,
): PathExtraction | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { raw: expr.text, dynamic: false };
  }

  if (ts.isTemplateExpression(expr)) {
    let raw = expr.head.text;
    let dynamic = false;
    for (const span of expr.templateSpans) {
      const resolved = resolveConstLiteralValue(span.expression, resolver);
      if (resolved !== null) {
        raw += resolved + span.literal.text;
      } else {
        dynamic = true;
        raw += "__DYN__" + span.literal.text;
      }
    }
    return { raw, dynamic };
  }

  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractPathExpression(expr.left, sourceFile, resolver);
    const right = extractPathExpression(expr.right, sourceFile, resolver);
    if (!left && !right) return null;
    const raw = (left?.raw ?? "__DYN__") + (right?.raw ?? "__DYN__");
    const dynamic = Boolean(left?.dynamic) || Boolean(right?.dynamic) || !left || !right;
    return { raw, dynamic };
  }

  if (ts.isParenthesizedExpression(expr)) {
    return extractPathExpression(expr.expression, sourceFile, resolver);
  }

  // Plain identifier / call / member access used as the whole URL, e.g.
  // `fetch(buildUrl(id))`. Try resolving it as a const literal first (e.g.
  // `fetch(API_BASE)` where `API_BASE` is a const string) before falling
  // back to fully dynamic — the route matcher will fuzzy-match on whatever
  // surrounding literal fragments exist elsewhere in the call if not.
  if (ts.isIdentifier(expr) || ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr)) {
    if (!ts.isCallExpression(expr)) {
      const resolved = resolveConstLiteralValue(expr, resolver);
      if (resolved !== null) return { raw: resolved, dynamic: false };
    }
    return { raw: "__DYN__", dynamic: true };
  }

  return null;
}

function findObjectLiteralProp(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name))
    ) {
      return prop.initializer;
    }
  }
  return null;
}

/** Walks upward from a call expression to find the nearest enclosing
 *  `VariableDeclaration`, looking through `await`, `.then(...)`, and simple
 *  member-access chains (e.g. `const x = (await axios.get(...)).data`). */
function findEnclosingVariableDeclaration(
  node: ts.Node,
): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node;
  for (let hops = 0; hops < 6 && current; hops++) {
    current = current.parent;
    if (!current) return null;
    if (ts.isVariableDeclaration(current)) return current;
    if (
      ts.isAwaitExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      continue;
    }
    // Stop walking once we leave a plausible expression chain.
    if (ts.isVariableStatement(current) || ts.isBlock(current) || ts.isSourceFile(current)) {
      return null;
    }
  }
  return null;
}

/** Infers a schema from the destination of a call-site's result: an
 *  explicit generic (`axios.get<User>`), an enclosing variable's type
 *  annotation, or an enclosing destructuring pattern. Falls back to `null`
 *  when nothing usable is present, which the validator treats as
 *  "unverifiable" rather than "broken". */
function inferExpectedSchema(
  call: ts.CallExpression,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  if (call.typeArguments && call.typeArguments.length > 0) {
    const schema = typeNodeToSchema(call.typeArguments[0] as ts.TypeNode, table, undefined, resolveExternal);
    if (schema) return schema;
  }

  const varDecl = findEnclosingVariableDeclaration(call);
  if (varDecl) {
    if (varDecl.type) {
      // Unwrap one layer of a generic wrapper, e.g. AxiosResponse<User> or Promise<User>.
      if (ts.isTypeReferenceNode(varDecl.type) && varDecl.type.typeArguments?.[0]) {
        const inner = typeNodeToSchema(varDecl.type.typeArguments[0], table, undefined, resolveExternal);
        if (inner) return inner;
      }
      const direct = typeNodeToSchema(varDecl.type, table, undefined, resolveExternal);
      if (direct) return direct;
    }
    if (varDecl.name && ts.isObjectBindingPattern(varDecl.name)) {
      return bindingPatternToSchema(varDecl.name);
    }
  }

  const thenSchema = inferSchemaFromThenChain(call, table, resolveExternal);
  if (thenSchema) return thenSchema;

  return null;
}

/** True for a call shaped like `<expr>.json()` — i.e. the Fetch API's
 *  `Response.json()` (or Fastify/undici's alike), regardless of what the
 *  receiver expression is. */
function isJsonCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "json"
  );
}

/** Unwraps one layer of `Promise<T>` from a type node, e.g. from an
 *  (unusual, but real) `as Promise<T>` assertion on a `.then()` callback's
 *  return value — the assertion is describing what the *outer* `.then()`
 *  chain ultimately resolves to, not the type of `.json()`'s own return. */
function unwrapPromiseType(t: ts.TypeNode): ts.TypeNode {
  if (
    ts.isTypeReferenceNode(t) &&
    t.typeName.getText() === "Promise" &&
    t.typeArguments?.[0]
  ) {
    return t.typeArguments[0];
  }
  return t;
}

/** Finds a type assertion (`as T` or `<T>expr`) wrapped directly around a
 *  `.json()` call anywhere inside a `.then()` callback body — the common
 *  `fetch(url).then(r => r.json() as Promise<T>)` pattern, where the
 *  expected shape lives inside the callback rather than as a generic on
 *  the call itself or an annotation on an enclosing variable. */
function findJsonAssertionType(node: ts.Node): ts.TypeNode | null {
  let found: ts.TypeNode | null = null;
  function visit(n: ts.Node): void {
    if (found) return;
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && isJsonCall(n.expression)) {
      found = n.type;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** Fallback for `fetch(url).then(r => r.json() as Promise<T>)`: `call` here
 *  is the inner `fetch(url)` node, so we look one level up for a `.then`
 *  property access whose owning call's first argument is a callback, then
 *  search that callback's body for the json-assertion pattern above. Only
 *  ever looks at the single `.then()` immediately chained off `call` —
 *  consistent with the one-hop resolution used elsewhere in this file. */
function inferSchemaFromThenChain(
  call: ts.CallExpression,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const parent = call.parent;
  if (!parent || !ts.isPropertyAccessExpression(parent) || parent.name.text !== "then") {
    return null;
  }
  const thenCall = parent.parent;
  if (!thenCall || !ts.isCallExpression(thenCall)) return null;
  const callback = thenCall.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    return null;
  }
  const assertedType = findJsonAssertionType(callback.body);
  if (!assertedType) return null;
  return typeNodeToSchema(unwrapPromiseType(assertedType), table, undefined, resolveExternal);
}

function methodFromObjectLiteral(obj: ts.ObjectLiteralExpression): HttpMethod {
  const m = findObjectLiteralProp(obj, "method");
  if (m && ts.isStringLiteral(m)) {
    return normalizeMethod(m.text);
  }
  return "GET";
}

function normalizeMethod(text: string): HttpMethod {
  const upper = text.toUpperCase();
  const valid: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  return (valid as string[]).includes(upper) ? (upper as HttpMethod) : "UNKNOWN";
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

function parseSourceFile(
  filePath: string,
  text: string,
  resolver: CrossFileResolver = new CrossFileResolver(),
): ClientCallSite[] {
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
  const results: ClientCallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const site = tryExtractCallSite(node, sourceFile, filePath, table, resolveExternal, resolver);
      if (site) {
        results.push(site);
        // Don't recurse into a call we just extracted a site from. The
        // useQuery/useMutation handler above resolves its URL by scanning
        // *into* its own callback argument (findFirstPathLiteralInArgs),
        // so `useQuery(["x", id], () => fetch(url))` matches at the outer
        // useQuery node. Continuing to recurse would then also independently
        // match the same nested fetch(...) call, double-reporting one real
        // endpoint as two call sites (one "react-query", one "fetch") with
        // identical routes — silently masked in the original test suite
        // because it asserted via `.find()` rather than a site count.
        // Verified this doesn't affect the legitimate multi-call case
        // (e.g. `axios.get(a).then(() => axios.get(b))`): the second call
        // there is a sibling under `.then(...)`, not a descendant of the
        // first call's own node, so it's still reached and extracted.
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return results;
}

function tryExtractCallSite(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  table: TypeTable,
  resolveExternal?: ExternalResolver,
  resolver?: CrossFileResolver,
): ClientCallSite | null {
  const callee = node.expression;

  // --- axios.<method>(url, ...) / apiClient.<method>(url, ...) ---------------
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text.toLowerCase();
    if (HTTP_METHOD_NAMES.has(methodName) && !looksLikeNonHttpReceiver(callee.expression)) {
      const urlArg = node.arguments[0];
      if (urlArg) {
        let pathInfo = extractPathExpression(urlArg, sourceFile, resolver);
        // Generated SDKs (e.g. @hey-api/openapi-ts, oazapfts) call
        // `client.post<T>({ url: "/api/v1/x", ... })` — a single options
        // object with a `url` property, not the URL as a bare first
        // argument. Found while running driftguard against a real
        // fullstack monorepo (fastapi/full-stack-fastapi-template), where
        // this pattern accounted for every generated SDK call in the app
        // and none of them were being detected at all.
        if (!pathInfo && ts.isObjectLiteralExpression(urlArg)) {
          const urlExpr = findObjectLiteralProp(urlArg, "url");
          if (urlExpr) pathInfo = extractPathExpression(urlExpr, sourceFile, resolver);
        }
        if (pathInfo) {
          const framework: ClientFramework = looksLikeAxiosReceiver(callee.expression)
            ? "axios"
            : "unknown";
          return buildCallSite(
            node,
            sourceFile,
            filePath,
            table,
            normalizeMethod(methodName),
            pathInfo,
            framework,
            resolveExternal,
          );
        }
      }
    }
    if (methodName === "request") {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const urlExpr = findObjectLiteralProp(arg, "url");
        if (urlExpr) {
          const pathInfo = extractPathExpression(urlExpr, sourceFile, resolver);
          if (pathInfo) {
            return buildCallSite(
              node,
              sourceFile,
              filePath,
              table,
              methodFromObjectLiteral(arg),
              pathInfo,
              "axios",
              resolveExternal,
            );
          }
        }
      }
    }
  }

  // --- fetch(url, { method }) --------------------------------------------
  if (ts.isIdentifier(callee) && callee.text === "fetch") {
    const urlArg = node.arguments[0];
    if (urlArg) {
      const pathInfo = extractPathExpression(urlArg, sourceFile, resolver);
      if (pathInfo) {
        const optsArg = node.arguments[1];
        const method =
          optsArg && ts.isObjectLiteralExpression(optsArg)
            ? methodFromObjectLiteral(optsArg)
            : "GET";
        return buildCallSite(node, sourceFile, filePath, table, method, pathInfo, "fetch", resolveExternal);
      }
    }
  }

  // --- useQuery(...) / useMutation(...) (React Query) --------------------
  if (ts.isIdentifier(callee) && (callee.text === "useQuery" || callee.text === "useSuspenseQuery")) {
    const pathInfo = findFirstPathLiteralInArgs(node.arguments, sourceFile, resolver);
    if (pathInfo) {
      return buildCallSite(node, sourceFile, filePath, table, "GET", pathInfo, "react-query", resolveExternal);
    }
  }

  return null;
}

/** A handful of built-in Web/DOM/collection APIs happen to share method
 *  names with HTTP verbs — `Headers.get`, `URLSearchParams.get/delete`,
 *  `Map`/`Set` methods, etc. — and, called with a single string argument,
 *  are syntactically indistinguishable from an `apiClient.get('/path')`
 *  call. A narrow receiver-name denylist prevents common built-ins such as
 *  `Headers` and `URLSearchParams` from becoming phantom API endpoints.
 *  The denylist is intentionally narrow rather than a broad receiver filter,
 *  so custom API wrappers remain detectable.
 *  name (`'login'`, `'reset'`) is completely indistinguishable from an
 *  arbitrary string key by shape alone — only the receiver gives it away. */
function looksLikeNonHttpReceiver(expr: ts.Expression): boolean {
  const text = expr.getText().toLowerCase();
  return (
    text === "headers" ||
    text.endsWith(".headers") ||
    text === "searchparams" ||
    text.endsWith(".searchparams") ||
    // `Map`/`WeakMap` share `.get()`/`.delete()`/`.has()` with the HTTP
    // verb set. Found while running driftguard against a real
    // fullstack monorepo: `map.get(config.key)` inside a generated SDK's
    // internal param-serialization helper (params.gen.ts) was reported
    // as a phantom GET call. Narrow identifier/property-suffix match,
    // same precedent as the headers/searchParams checks above — not a
    // broad "unknown receivers are excluded" rule.
    text === "map" ||
    text.endsWith(".map")
  );
}

function looksLikeAxiosReceiver(expr: ts.Expression): boolean {
  const text = expr.getText().toLowerCase();
  return (
    text === "axios" ||
    text.includes("axios") ||
    text.includes("api") ||
    text.includes("client") ||
    text.includes("http")
  );
}

/** Best-effort scan for a string literal that looks like an API path,
 *  used to resolve `useQuery` call sites whose URL lives inside a nested
 *  fetcher callback rather than as a direct argument. */
function findFirstPathLiteralInArgs(
  args: ts.NodeArray<ts.Expression>,
  sourceFile: ts.SourceFile,
  resolver?: CrossFileResolver,
): PathExtraction | null {
  let found: PathExtraction | null = null;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.startsWith("/")
    ) {
      found = { raw: node.text, dynamic: false };
      return;
    }
    if (ts.isTemplateExpression(node) && node.getText().includes("/")) {
      const extracted = extractPathExpression(node, sourceFile, resolver);
      if (extracted) {
        found = extracted;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  for (const arg of args) visit(arg);
  return found;
}

function buildCallSite(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  table: TypeTable,
  method: HttpMethod,
  pathInfo: PathExtraction,
  framework: ClientFramework,
  resolveExternal?: ExternalResolver,
): ClientCallSite {
  const loc = locationOf(sourceFile, node);
  return {
    id: nextId("ts-client"),
    method,
    route: parseRouteTemplate(pathInfo.raw),
    dynamic: pathInfo.dynamic,
    expectedSchema: inferExpectedSchema(node, table, resolveExternal),
    framework,
    location: { file: filePath, line: loc.line, column: loc.column },
  };
}

/** Parses every TypeScript/JavaScript client call-site under `rootDir`. */
export function parseTsClientCallSites(rootDir: string): ClientCallSite[] {
  const files = walkFiles(rootDir, CLIENT_EXTENSIONS);
  // One resolver per run, shared across every file: a shared-package file
  // imported from several client files (common in a monorepo) is only
  // ever parsed once, no matter how many local files import from it.
  const resolver = new CrossFileResolver();
  const results: ClientCallSite[] = [];
  for (const file of files) {
    // A single pathologically-shaped file (e.g. thousands of unbalanced
    // braces — degenerate/corrupted source, minified/generated output, or
    // even a non-TS file that happens to carry a .ts extension) can drive
    // the TypeScript compiler's recursive-descent parser deep enough to
    // stack-overflow. That's a plain, catchable JS RangeError — confirmed
    // by reproducing it directly — but left unguarded it's an uncaught
    // exception that kills the entire run and discards every other file's
    // (valid) results along with it. One bad file out of thousands
    // shouldn't take down the whole analysis; skip it, warn, and keep
    // going, the same fail-safe posture the rest of this tool already
    // takes toward unparseable/unresolvable input.
    try {
      results.push(...parseSourceFile(file, fs.readFileSync(file, "utf8"), resolver));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}

/**
 * Parses every supported client call-site under `rootDir` across all
 * languages driftguard understands: TypeScript/JavaScript (full AST,
 * via the TypeScript compiler API), Python (`requests`/`httpx`, real AST
 * via tree-sitter), and Go (`net/http`, real AST via tree-sitter). The
 * Python/Go passes are async because loading their tree-sitter grammar is
 * async (see tree-sitter-loader.ts); TS/JS stays sync since the TypeScript
 * compiler API is synchronous, so it isn't awaited unnecessarily.
 */
export async function parseClientCallSites(rootDir: string): Promise<ClientCallSite[]> {
  const [pythonResults, goResults] = await Promise.all([
    parsePythonClientCallSites(rootDir),
    parseGoClientCallSites(rootDir),
  ]);
  return [...parseTsClientCallSites(rootDir), ...pythonResults, ...goResults];
}

/** Parses a single in-memory source string directly, with no filesystem
 *  I/O — this is what the unit tests use so fixtures can live as inline
 *  template strings. `filePath` is cosmetic (used for location reporting). */
export function parseClientSource(filePath: string, source: string): ClientCallSite[] {
  return parseSourceFile(filePath, source);
}
