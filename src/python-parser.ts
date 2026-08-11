import fs from "node:fs";
import path from "node:path";
import type Parser from "web-tree-sitter";
import type {
  ClientCallSite,
  Field,
  FieldType,
  HttpMethod,
  Schema,
  ServerHandler,
} from "./types.js";
import { parseRouteTemplate } from "./route-template.js";
import { walkFiles } from "./fs-walk.js";
import { getParser } from "./tree-sitter-loader.js";

/**
 * Real Python AST parsing via tree-sitter (see tree-sitter-loader.ts for
 * why WASM rather than the native `tree-sitter` bindings). This replaced
 * an earlier regex/line-based extractor: regex degrades badly on multi-line
 * signatures, stacked decorators, nested generics, and any formatting the
 * original author's `black`/`ruff` config didn't happen to produce.
 * Structurally walking the real grammar handles all of that for free.
 *
 * Covers the common FastAPI + `requests`/`httpx` idioms:
 *
 *   @app.get("/users/{id}")
 *   def get_user(id: int) -> UserOut: ...
 *
 *   class UserOut(BaseModel):
 *       id: int
 *       name: str
 *       email: Optional[str] = None
 *
 *   requests.get(f"/users/{user_id}")
 *
 * Anything the grammar parses but this module doesn't yet model (walrus
 * operators inside route decorators, dataclasses instead of Pydantic,
 * etc.) is skipped rather than guessed at, matching the tool's
 * "unresolved > wrong" philosophy for schema inference.
 */

const PY_EXTENSIONS = [".py"];
const HTTP_DECORATOR_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const REQUEST_RECEIVER_NAMES = new Set(["requests", "httpx", "client", "session"]);
const REQUEST_METHOD_NAMES = new Set(["get", "post", "put", "patch", "delete"]);

type Node = Parser.SyntaxNode;

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

function locationOf(node: Node): { line: number; column: number } {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

/** Depth-first walk over every node in the tree, named or not. */
function* walk(node: Node): Generator<Node> {
  yield node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) yield* walk(child);
  }
}

/** Converts a Python `type` annotation node (e.g. `Optional[List[UserOut]]`)
 *  into a `Field`, resolving model references against `models`. Operates
 *  on the actual annotation subtree rather than a stringified/regex form,
 *  so nested generics and unions of arbitrary depth resolve correctly. */
function annotationNodeToField(node: Node, models: Map<string, Schema>): Field {
  // A `type` wrapper node just carries a single child; unwrap it.
  if (node.type === "type" && node.namedChildCount === 1) {
    return annotationNodeToField(node.namedChild(0) as Node, models);
  }

  if (node.type === "generic_type") {
    const base = node.namedChild(0);
    const paramsNode = node.namedChild(1); // type_parameter, holds one or more `type` children
    const baseName = base?.text ?? "";
    const innerTypes = paramsNode ? paramsNode.namedChildren.filter((c) => c.type === "type") : [];
    const firstInner = innerTypes[0];

    if (baseName === "Optional" && firstInner) {
      const inner = annotationNodeToField(firstInner, models);
      return { ...inner, optional: true, nullable: true };
    }
    if ((baseName === "List" || baseName === "list") && firstInner) {
      const inner = annotationNodeToField(firstInner, models);
      return { type: { kind: "array", element: inner.type }, optional: false, nullable: false };
    }
    if (baseName === "Dict" || baseName === "dict") {
      return { type: { kind: "primitive", name: "any" }, optional: false, nullable: false };
    }
    // Unrecognized generic wrapper (e.g. a user-defined Generic[T]) — treat
    // as a reference to the base name rather than guessing at its shape.
    return { type: { kind: "reference", name: baseName }, optional: false, nullable: false };
  }

  // `X | None` / `X | Y` union syntax (PEP 604).
  if (node.type === "binary_operator") {
    const operatorField = node.children.find((c) => c.type === "|");
    if (operatorField) {
      const left = node.childForFieldName("left") ?? node.namedChild(0);
      const right = node.childForFieldName("right") ?? node.namedChild(1);
      if (right && right.type === "none") {
        const inner = left
          ? annotationNodeToField(left, models)
          : { type: { kind: "primitive", name: "unknown" } as FieldType, optional: false, nullable: false };
        return { ...inner, optional: true, nullable: true };
      }
      // General union: model as `unknown` rather than fabricating a shape
      // — the validator treats `unknown` as accepting anything, the
      // conservative choice for a union we can't fully resolve.
      return { type: { kind: "primitive", name: "unknown" }, optional: false, nullable: false };
    }
  }

  const text = node.text.trim();
  let type: FieldType;
  switch (text) {
    case "str":
      type = { kind: "primitive", name: "string" };
      break;
    case "int":
    case "float":
      type = { kind: "primitive", name: "number" };
      break;
    case "bool":
      type = { kind: "primitive", name: "boolean" };
      break;
    case "None":
      type = { kind: "primitive", name: "null" };
      break;
    case "dict":
    case "Dict":
    case "Any":
      type = { kind: "primitive", name: "any" };
      break;
    default: {
      const model = models.get(text);
      type = model ? { kind: "object", fields: model.fields } : { kind: "reference", name: text };
    }
  }
  return { type, optional: false, nullable: false };
}

/** Finds every `class X(BaseModel): ...` / `class X(Schema): ...` in the
 *  tree and builds a name -> Schema table. Two passes so models can
 *  reference other models declared later in the file. */
function extractPydanticModels(root: Node): Map<string, Schema> {
  const raw: { name: string; fields: { key: string; annotation: Node }[] }[] = [];

  for (const node of walk(root)) {
    if (node.type !== "class_definition") continue;
    const nameNode = node.childForFieldName("name");
    const superclasses = node.childForFieldName("superclasses");
    if (!nameNode || !superclasses) continue;
    if (!/BaseModel|Schema/.test(superclasses.text)) continue;

    const body = node.childForFieldName("body");
    const fields: { key: string; annotation: Node }[] = [];
    if (body) {
      for (const stmt of body.namedChildren) {
        // Annotated assignment: `field: Type` or `field: Type = default`,
        // parsed as expression_statement -> assignment(left, type, right?).
        if (stmt.type !== "expression_statement") continue;
        const assignment = stmt.namedChild(0);
        if (!assignment || assignment.type !== "assignment") continue;
        const left = assignment.childForFieldName("left");
        const typeNode = assignment.childForFieldName("type");
        if (left && typeNode && left.type === "identifier") {
          fields.push({ key: left.text, annotation: typeNode });
        }
      }
    }
    raw.push({ name: nameNode.text, fields });
  }

  const models = new Map<string, Schema>();
  for (const m of raw) models.set(m.name, { kind: "object", name: m.name, fields: {} });
  for (const m of raw) {
    const fields: Record<string, Field> = {};
    for (const f of m.fields) {
      fields[f.key] = annotationNodeToField(f.annotation, models);
    }
    (models.get(m.name) as Schema).fields = fields;
  }
  return models;
}

/** Finds every `name = APIRouter(prefix="...")` assignment and builds a
 *  variable name -> prefix map. Unlike Gin's `.Group()` chaining, FastAPI
 *  `APIRouter` prefixes aren't nested at construction time — a router is
 *  built once with its full prefix and mounted directly — so this is a
 *  single pass rather than a resolve-through-parents walk. */
function extractRouterPrefixes(root: Node): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const node of walk(root)) {
    if (node.type !== "assignment") continue;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || left.type !== "identifier" || !right || right.type !== "call") continue;
    const fn = right.childForFieldName("function");
    if (!fn || fn.type !== "identifier" || fn.text !== "APIRouter") continue;
    let prefix = "";
    const args = right.childForFieldName("arguments");
    for (const arg of args?.namedChildren ?? []) {
      if (arg.type !== "keyword_argument") continue;
      const key = arg.childForFieldName("name");
      const value = arg.childForFieldName("value");
      if (key?.text === "prefix" && value?.type === "string") {
        prefix = stringNodeToTemplate(value).text;
      }
    }
    // Register every APIRouter(...) var, even with no local `prefix=` (""),
    // so a cross-file external prefix (see resolvePythonCrossFileRouterPrefixes)
    // always has a local entry to merge into.
    prefixes.set(left.text, prefix);
  }
  return prefixes;
}

/** `@app.get("/path")` / `@router.post("/path")` — a decorator wrapping a
 *  `call` whose callee is `<name>.<http-method>` and whose first argument
 *  is a string/f-string literal. Also captures `response_model=` if
 *  present as a keyword argument, since it takes priority over the
 *  function's return-type annotation for what FastAPI actually puts on
 *  the wire (see `responseModelName` usage in the caller below), and
 *  prepends the router's `prefix=` (see `extractRouterPrefixes`) if the
 *  decorator's own object was constructed with one — a route registered
 *  via `router.get("/users/{id}")` on a `router = APIRouter(prefix="/api/v1")`
 *  is actually served at `/api/v1/users/{id}`; reporting the bare
 *  decorator path silently drops the prefix every real request needs. */
function matchHttpDecorator(
  decoratorCall: Node,
  routerPrefixes: Map<string, string>,
): { method: string; routePath: string; dynamic: boolean; responseModelName: string | null } | null {
  if (decoratorCall.type !== "call") return null;
  const fn = decoratorCall.childForFieldName("function");
  if (!fn || fn.type !== "attribute") return null;
  const attr = fn.childForFieldName("attribute");
  if (!attr || !HTTP_DECORATOR_METHODS.has(attr.text)) return null;
  const receiver = fn.childForFieldName("object");

  const args = decoratorCall.childForFieldName("arguments");
  const firstArg = args?.namedChildren[0];
  if (!firstArg || firstArg.type !== "string") return null;
  const { text: pathText, dynamic } = stringNodeToTemplate(firstArg);
  const prefix = (receiver && routerPrefixes.get(receiver.text)) || "";
  const routePath = prefix + pathText;

  let responseModelName: string | null = null;
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== "keyword_argument") continue;
    const key = arg.childForFieldName("name");
    const value = arg.childForFieldName("value");
    if (key?.text === "response_model" && value?.type === "identifier") {
      responseModelName = value.text;
    }
  }

  return { method: attr.text, routePath, dynamic, responseModelName };
}

/** Extracts the text of a Python `string` node, replacing every
 *  `{expr}` f-string interpolation with the `__DYN__` placeholder token
 *  `route-template.ts` recognizes. Plain strings simply have no
 *  `interpolation` children, so `dynamic` comes back `false` for them. */
function stringNodeToTemplate(stringNode: Node): { text: string; dynamic: boolean } {
  let text = "";
  let dynamic = false;
  for (const child of stringNode.namedChildren) {
    if (child.type === "string_content") text += child.text;
    else if (child.type === "interpolation") {
      text += "__DYN__";
      dynamic = true;
    }
  }
  return { text, dynamic };
}

function inferLiteralType(node: Node): FieldType {
  switch (node.type) {
    case "string":
      return { kind: "primitive", name: "string" };
    case "integer":
    case "float":
      return { kind: "primitive", name: "number" };
    case "true":
    case "false":
      return { kind: "primitive", name: "boolean" };
    case "none":
      return { kind: "primitive", name: "null" };
    case "list":
      return { kind: "array", element: { kind: "primitive", name: "unknown" } };
    default:
      return { kind: "primitive", name: "unknown" };
  }
}

/** Fallback: scans a function body for a `return {"key": value, ...}` dict
 *  literal (the first one found, matching the tool's "conservative,
 *  shallow response modeling" approach) and infers a shallow schema from
 *  the literal's own AST — no annotation needed. */
function extractDictReturnSchema(functionBody: Node): Schema | null {
  for (const node of walk(functionBody)) {
    if (node.type !== "return_statement") continue;
    const dict = node.namedChildren.find((c) => c.type === "dictionary");
    if (!dict) continue;
    const fields: Record<string, Field> = {};
    for (const pair of dict.namedChildren) {
      if (pair.type !== "pair") continue;
      const keyNode = pair.childForFieldName("key");
      const valueNode = pair.childForFieldName("value");
      if (!keyNode || !valueNode) continue;
      const key = keyNode.type === "string" ? stringNodeToTemplate(keyNode).text : null;
      if (key === null) continue;
      fields[key] = { type: inferLiteralType(valueNode), optional: false, nullable: false };
    }
    if (Object.keys(fields).length > 0) return { kind: "object", fields };
  }
  return null;
}

export function parsePythonServerSourceFromTree(
  filePath: string,
  tree: Parser.Tree,
  externalPrefixes?: Map<string, string>,
): ServerHandler[] {
  const root = tree.rootNode;
  const models = extractPydanticModels(root);
  const localPrefixes = extractRouterPrefixes(root);
  // A router built here with its own `prefix=` can *also* be mounted
  // elsewhere (often several files away, via `include_router(prefix=...)`
  // composition, see resolvePythonCrossFileRouterPrefixes) with a further
  // prefix stacked on top — e.g. `api_router.include_router(users.router)`
  // in api/main.py, then `app.include_router(api_router, prefix="/api/v1")`
  // in main.py. Reporting only the file-local prefix silently drops that.
  const routerPrefixes = externalPrefixes
    ? new Map(
        [...localPrefixes].map(([varName, prefix]) => [
          varName,
          (externalPrefixes.get(varName) ?? "") + prefix,
        ]),
      )
    : localPrefixes;
  const handlers: ServerHandler[] = [];

  for (const node of walk(root)) {
    if (node.type !== "decorated_definition") continue;
    const fnDef = node.namedChildren.find((c) => c.type === "function_definition");
    if (!fnDef) continue;

    let matched: { method: string; routePath: string; dynamic: boolean; responseModelName: string | null } | null =
      null;
    let decoratorNode: Node = node;
    for (const child of node.namedChildren) {
      if (child.type !== "decorator") continue;
      const call = child.namedChild(0);
      if (!call) continue;
      const m = matchHttpDecorator(call, routerPrefixes);
      if (m) {
        matched = m;
        decoratorNode = child;
        break;
      }
    }
    if (!matched) continue;

    // Priority order mirrors what FastAPI actually puts on the wire:
    // `response_model=` (when present) always wins over the function's own
    // return-type annotation — Pydantic serializes *through* response_model,
    // silently dropping fields the handler returns that aren't declared on
    // it and coercing types to match it. A handler can freely return extra
    // internal fields or a bare dict; only response_model's shape is ever
    // actually sent to the client. Falling back to inferring from the
    // return statement in that case (as this parser previously did
    // unconditionally) risks reporting fields that are silently stripped
    // in production as if they were part of the real contract.
    let responseSchema: Schema | null = null;
    if (matched.responseModelName) {
      const model = models.get(matched.responseModelName);
      if (model) responseSchema = model;
    }

    const returnTypeNode = fnDef.childForFieldName("return_type");
    if (!responseSchema && returnTypeNode) {
      const field = annotationNodeToField(returnTypeNode, models);
      if (field.type.kind === "object") {
        responseSchema = { kind: "object", fields: field.type.fields };
      } else if (field.type.kind === "array" && field.type.element.kind === "object") {
        responseSchema = { kind: "object", fields: field.type.element.fields };
      }
    }

    const body = fnDef.childForFieldName("body");
    if (!responseSchema && body) {
      responseSchema = extractDictReturnSchema(body);
    }

    handlers.push({
      id: nextId("py-server"),
      method: normalizeMethod(matched.method),
      route: parseRouteTemplate(matched.routePath),
      responseSchema,
      framework: "fastapi",
      location: { file: filePath, ...locationOf(decoratorNode) },
    });
  }

  return handlers;
}

export function parsePythonClientSourceFromTree(filePath: string, tree: Parser.Tree): ClientCallSite[] {
  const root = tree.rootNode;
  const results: ClientCallSite[] = [];

  for (const node of walk(root)) {
    if (node.type !== "call") continue;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "attribute") continue;
    const object = fn.childForFieldName("object");
    const attr = fn.childForFieldName("attribute");
    if (!object || !attr) continue;
    if (!REQUEST_RECEIVER_NAMES.has(object.text) || !REQUEST_METHOD_NAMES.has(attr.text)) continue;

    const args = node.childForFieldName("arguments");
    const urlArg = args?.namedChildren[0];
    if (!urlArg || urlArg.type !== "string") continue;

    const { text: raw, dynamic } = stringNodeToTemplate(urlArg);
    results.push({
      id: nextId("py-client"),
      method: normalizeMethod(attr.text),
      route: parseRouteTemplate(raw),
      dynamic,
      expectedSchema: null,
      framework: "unknown",
      location: { file: filePath, ...locationOf(node) },
    });
  }

  return results;
}

async function parseFile(filePath: string): Promise<Parser.Tree> {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = await getParser("python");
  return parser.parse(source);
}

/** Async, in-memory variant of `parsePythonServerSourceFromTree` — this is
 *  what unit tests use so fixtures can live as inline template strings
 *  with no filesystem I/O. `filePath` is cosmetic (used for location
 *  reporting). */
export async function parsePythonServerSource(filePath: string, source: string): Promise<ServerHandler[]> {
  const parser = await getParser("python");
  return parsePythonServerSourceFromTree(filePath, parser.parse(source));
}

/** Async, in-memory variant of `parsePythonClientSourceFromTree`. See
 *  `parsePythonServerSource` above. */
export async function parsePythonClientSource(filePath: string, source: string): Promise<ClientCallSite[]> {
  const parser = await getParser("python");
  return parsePythonClientSourceFromTree(filePath, parser.parse(source));
}

/** A tracked `import` binding: either a whole-module import (`symbol ===
 *  null`, e.g. `import app.api.main as apimain`) or a name pulled out of a
 *  module (`from app.core.config import settings`, `symbol === "settings"`),
 *  which itself may turn out to be a submodule (resolved by trying
 *  `moduleSegments + [symbol]` as a file path first) or a plain value. */
interface ImportRef {
  moduleSegments: string[];
  symbol: string | null;
}

/** Builds a local-alias -> import-target map from every `import`/`from
 *  ... import` statement in a file. Deliberately does not handle
 *  `from x import *` — resolving a wildcard would require enumerating
 *  every symbol the target module exports, and wildcard imports are rare
 *  in FastAPI router-composition code in practice. */
function extractImports(root: Node): Map<string, ImportRef> {
  const imports = new Map<string, ImportRef>();
  for (const node of walk(root)) {
    if (node.type === "import_from_statement") {
      const moduleNode = node.namedChild(0);
      if (!moduleNode || moduleNode.type !== "dotted_name") continue;
      const moduleSegments = moduleNode.namedChildren.map((c) => c.text);
      for (let i = 1; i < node.namedChildCount; i++) {
        const child = node.namedChild(i) as Node;
        if (child.type === "dotted_name") {
          imports.set(child.text, { moduleSegments, symbol: child.text });
        } else if (child.type === "aliased_import") {
          const dotted = child.namedChildren.find((c) => c.type === "dotted_name");
          const aliasId = child.namedChildren.find((c) => c.type === "identifier");
          if (dotted && aliasId) {
            imports.set(aliasId.text, { moduleSegments, symbol: dotted.text });
          }
        }
      }
    } else if (node.type === "import_statement") {
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name") {
          // `import a.b.c` (no alias): binds the outermost package name
          // in real Python, but this codebase only cares about resolving
          // `a.b.c`-style references, so aliasing the full dotted path
          // to its last segment is a deliberate simplification — this
          // branch is rarely hit by router-mounting code, which almost
          // always uses `from ... import ...`.
          const segments = child.namedChildren.map((c) => c.text);
          const alias = segments[segments.length - 1];
          if (alias) imports.set(alias, { moduleSegments: segments, symbol: null });
        } else if (child.type === "aliased_import") {
          const dotted = child.namedChildren.find((c) => c.type === "dotted_name");
          const aliasId = child.namedChildren.find((c) => c.type === "identifier");
          if (dotted && aliasId) {
            const segments = dotted.namedChildren.map((c) => c.text);
            imports.set(aliasId.text, { moduleSegments: segments, symbol: null });
          }
        }
      }
    }
  }
  return imports;
}

/** Resolves a dotted module path (e.g. `["app","api","routes","users"]`,
 *  from `from app.api.routes import users`) to a real file under the
 *  scanned root. Tries the full path first, then progressively drops
 *  leading segments — this handles the common case where the scanned
 *  root directory (e.g. `backend/app`, pointed to via `--server`) *is*
 *  the leading package segment (`app`) referenced in every import,
 *  without needing to know the project's actual package root ahead of
 *  time. Returns null (rather than guessing) if nothing matches, so an
 *  unresolvable import simply contributes no prefix instead of a wrong one. */
function resolveModuleToFile(dottedFileIndex: Map<string, string>, segments: string[]): string | null {
  for (let drop = 0; drop < segments.length; drop++) {
    const candidate = segments.slice(drop).join(".");
    const match = dottedFileIndex.get(candidate);
    if (match) return match;
  }
  return null;
}

/** Finds a top-level or class-body `NAME: type = "literal"` / `NAME =
 *  "literal"` assignment for `attrName` in `file` and returns its literal
 *  string value — used to resolve `prefix=settings.API_V1_STR`-style
 *  values back to the pydantic-settings class attribute that defines
 *  them. Returns null (rather than guessing) if no literal is found. */
function resolveLiteralConstant(trees: Map<string, Parser.Tree>, file: string, attrName: string): string | null {
  const tree = trees.get(file);
  if (!tree) return null;
  for (const node of walk(tree.rootNode)) {
    if (node.type !== "assignment") continue;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type === "identifier" && left.text === attrName && right?.type === "string") {
      return stringNodeToTemplate(right).text;
    }
  }
  return null;
}

/** Resolves the value of an `include_router(..., prefix=<value>)` keyword
 *  argument. Handles a string literal directly, or a single-hop attribute
 *  reference like `settings.API_V1_STR` by tracing `settings` back to its
 *  import and reading the literal off the class attribute in that file.
 *  Anything else (a locally-computed expression, an env var lookup, etc.)
 *  resolves to "" — no inferred prefix — rather than guessing. */
function resolvePrefixValue(
  valueNode: Node,
  imports: Map<string, ImportRef>,
  dottedFileIndex: Map<string, string>,
  trees: Map<string, Parser.Tree>,
): string {
  if (valueNode.type === "string") return stringNodeToTemplate(valueNode).text;
  if (valueNode.type === "attribute") {
    const obj = valueNode.childForFieldName("object");
    const attr = valueNode.childForFieldName("attribute");
    if (obj?.type === "identifier" && attr) {
      const ref = imports.get(obj.text);
      if (ref?.symbol) {
        const targetFile = resolveModuleToFile(dottedFileIndex, ref.moduleSegments);
        if (targetFile) {
          const literal = resolveLiteralConstant(trees, targetFile, attr.text);
          if (literal !== null) return literal;
        }
      }
    }
  }
  return "";
}

interface RouterEdge {
  mountingKey: string;
  mountedKey: string;
  prefix: string;
}

/** Finds every `<mounting>.include_router(<mounted>[, prefix=<value>])`
 *  call in a file and turns each into an edge in the project-wide router
 *  composition graph, resolving `<mounted>` to the file+variable where
 *  that router was actually constructed — whether it's a local variable
 *  (`app_router.include_router(other_local_router)`), a submodule
 *  attribute (`api_router.include_router(users.router)`), or a directly
 *  imported symbol (`api_router.include_router(users_router)` where
 *  `users_router` came from `from app.api.routes.users import router as
 *  users_router`). */
function collectIncludeRouterEdges(
  file: string,
  root: Node,
  imports: Map<string, ImportRef>,
  localRouterVars: Set<string>,
  dottedFileIndex: Map<string, string>,
  trees: Map<string, Parser.Tree>,
): RouterEdge[] {
  const edges: RouterEdge[] = [];
  for (const node of walk(root)) {
    if (node.type !== "call") continue;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "attribute") continue;
    const methodAttr = fn.childForFieldName("attribute");
    if (!methodAttr || methodAttr.text !== "include_router") continue;
    const receiver = fn.childForFieldName("object");
    if (!receiver || receiver.type !== "identifier") continue;
    const mountingKey = `${file}::${receiver.text}`;

    const args = node.childForFieldName("arguments");
    const firstArg = args?.namedChildren.find((a) => a.type !== "keyword_argument");
    if (!firstArg) continue;

    let mountedKey: string | null = null;
    if (firstArg.type === "attribute") {
      const obj = firstArg.childForFieldName("object");
      const mountedAttr = firstArg.childForFieldName("attribute");
      if (obj?.type === "identifier" && mountedAttr) {
        const ref = imports.get(obj.text);
        if (ref) {
          const targetSegments = ref.symbol ? [...ref.moduleSegments, ref.symbol] : ref.moduleSegments;
          const targetFile = resolveModuleToFile(dottedFileIndex, targetSegments);
          if (targetFile) mountedKey = `${targetFile}::${mountedAttr.text}`;
        }
      }
    } else if (firstArg.type === "identifier") {
      if (localRouterVars.has(firstArg.text)) {
        mountedKey = `${file}::${firstArg.text}`;
      } else {
        const ref = imports.get(firstArg.text);
        if (ref?.symbol) {
          const targetFile = resolveModuleToFile(dottedFileIndex, ref.moduleSegments);
          if (targetFile) mountedKey = `${targetFile}::${ref.symbol}`;
        }
      }
    }
    if (!mountedKey) continue;

    let prefix = "";
    for (const arg of args?.namedChildren ?? []) {
      if (arg.type !== "keyword_argument") continue;
      const key = arg.childForFieldName("name");
      const value = arg.childForFieldName("value");
      if (key?.text === "prefix" && value) {
        prefix = resolvePrefixValue(value, imports, dottedFileIndex, trees);
      }
    }
    edges.push({ mountingKey, mountedKey, prefix });
  }
  return edges;
}

/** Resolves the prefix each `APIRouter` variable in the project picks up
 *  from being mounted (possibly through several layers of aggregator
 *  files) via `include_router(..., prefix=...)`. FastAPI apps commonly
 *  split routing across files — a `routes/users.py` router with its own
 *  `prefix="/users"`, aggregated into an `api_router` in `api/main.py`
 *  with no prefix of its own, finally mounted in `main.py` via
 *  `app.include_router(api_router, prefix=settings.API_V1_STR)`. Each of
 *  those three files parses in isolation elsewhere in this module, so
 *  none of them alone has enough information to know a route decorated
 *  `@router.get("/me")` in routes/users.py is actually served at
 *  `/api/v1/users/me` — that requires walking the composition graph
 *  across all three files, which is what this function does.
 *
 *  Returns file -> (local router variable name -> external prefix to
 *  prepend on top of that variable's own file-local `prefix=`, if any).
 *  Unresolvable pieces (an import that doesn't map to a file under
 *  `rootDir`, a prefix value that isn't a literal or a settings-style
 *  single-hop attribute lookup, mounting through a **kwargs-spread, etc.)
 *  are simply left out rather than guessed at — a route that resolves to
 *  its unprefixed form is treated as more useful than one confidently
 *  reported with an unsupported prefix. */
function buildRouterPrefixIndex(
  rootDir: string,
  files: string[],
  trees: Map<string, Parser.Tree>,
): Map<string, Map<string, string>> {
  const dottedFileIndex = new Map<string, string>();
  for (const f of files) {
    let rel = path.relative(rootDir, f).split(path.sep).join(".");
    rel = rel.replace(/\.py$/, "").replace(/(^|\.)__init__$/, "");
    if (rel && !dottedFileIndex.has(rel)) dottedFileIndex.set(rel, f);
  }

  const allEdges: RouterEdge[] = [];
  for (const file of files) {
    const tree = trees.get(file);
    if (!tree) continue;
    // Same per-file isolation as the main parse loop below: walking a
    // pathologically malformed file's AST (see the stack-overflow
    // regression tests) can throw here too, and one bad file shouldn't
    // blank out prefix resolution for every other file in the project.
    // The main loop re-attempts this exact file and logs the failure.
    try {
      const root = tree.rootNode;
      const imports = extractImports(root);
      const localVars = new Set(extractRouterPrefixes(root).keys());
      allEdges.push(...collectIncludeRouterEdges(file, root, imports, localVars, dottedFileIndex, trees));
    } catch {
      continue;
    }
  }

  // Fixed-point (Jacobi-style) relaxation: a router's external prefix
  // depends on the external prefix of whatever mounts it, which may
  // itself depend on another level up. 10 passes comfortably covers any
  // realistic router-composition depth (real FastAPI apps rarely nest
  // more than 2-3 levels) without needing a real topological sort.
  let current = new Map<string, string>();
  for (let pass = 0; pass < 10; pass++) {
    const contributions = new Map<string, string>();
    for (const edge of allEdges) {
      const parentPrefix = current.get(edge.mountingKey) ?? "";
      const contribution = parentPrefix + edge.prefix;
      contributions.set(edge.mountedKey, (contributions.get(edge.mountedKey) ?? "") + contribution);
    }
    for (const [key, value] of contributions) current.set(key, value);
  }

  const result = new Map<string, Map<string, string>>();
  for (const [key, prefix] of current) {
    const sep = key.lastIndexOf("::");
    const file = key.slice(0, sep);
    const varName = key.slice(sep + 2);
    if (!result.has(file)) result.set(file, new Map());
    result.get(file)?.set(varName, prefix);
  }
  return result;
}

export async function parsePythonServerHandlers(rootDir: string): Promise<ServerHandler[]> {
  const files = walkFiles(rootDir, PY_EXTENSIONS);
  const trees = new Map<string, Parser.Tree>();
  for (const file of files) {
    try {
      trees.set(file, await parseFile(file));
    } catch {
      // Left out of `trees` on failure; the per-file loop below
      // re-attempts parseFile on this exact file and logs the failure
      // through the same skip-and-continue path used everywhere else
      // (see the try/catch immediately below — this keeps Finding 3's
      // per-file isolation guarantee even though prefix resolution now
      // needs every file's tree up front).
    }
  }
  const externalPrefixesByFile = buildRouterPrefixIndex(rootDir, files, trees);

  const results: ServerHandler[] = [];
  for (const file of files) {
    // See the matching try/catch in server-parser.ts's parseTsServerHandlers
    // for why: a single file that fails to parse (missing grammar,
    // malformed source, anything) shouldn't discard every other file's
    // valid results.
    try {
      const tree = trees.get(file) ?? (await parseFile(file));
      results.push(...parsePythonServerSourceFromTree(file, tree, externalPrefixesByFile.get(file)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}

export async function parsePythonClientCallSites(rootDir: string): Promise<ClientCallSite[]> {
  const files = walkFiles(rootDir, PY_EXTENSIONS);
  const results: ClientCallSite[] = [];
  for (const file of files) {
    try {
      results.push(...parsePythonClientSourceFromTree(file, await parseFile(file)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}
