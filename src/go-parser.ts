import fs from "node:fs";
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
 * Real Go AST parsing via tree-sitter (see tree-sitter-loader.ts for why
 * WASM rather than the native `tree-sitter` bindings, or shelling out to
 * `go/ast` via the Go toolchain — the latter would also violate the
 * zero-execution constraint). This replaced an earlier line-by-line regex
 * extractor, which broke on multi-line struct tags, struct literals split
 * across lines, and router groups nested more than one level deep.
 *
 * Covers the common Gin + `net/http`/`resty` idioms:
 *
 *   router.GET("/users/:id", getUser)
 *   func getUser(c *gin.Context) {
 *       c.JSON(http.StatusOK, UserOut{ID: id, Name: name})
 *   }
 *   type UserOut struct {
 *       ID   int    `json:"id"`
 *       Name string `json:"name"`
 *   }
 *   http.Get("/users/" + id)
 */

const GO_EXTENSIONS = [".go"];
const ROUTER_RECEIVER_RE = /^router\d*$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CLIENT_RECEIVERS = new Set(["http", "client"]);

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

function* walk(node: Node): Generator<Node> {
  yield node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) yield* walk(child);
  }
}

/** Strips the surrounding quote/backtick characters from a Go string node's
 *  raw text — Go string content isn't a separate named child in this
 *  grammar the way Python's f-string interpolations are, so this is just
 *  slicing rather than tree-walking. */
function stringLiteralText(node: Node): string {
  return node.text.slice(1, -1);
}

function goTypeToFieldType(typeNode: Node, structs: Map<string, Schema>): { type: FieldType; optional: boolean } {
  if (typeNode.type === "pointer_type") {
    const inner = goTypeToFieldType(typeNode.namedChild(0) as Node, structs);
    return { type: inner.type, optional: true };
  }
  if (typeNode.type === "slice_type" || typeNode.type === "array_type") {
    const element = typeNode.namedChild(typeNode.namedChildCount - 1) as Node;
    return { type: { kind: "array", element: goTypeToFieldType(element, structs).type }, optional: false };
  }
  if (typeNode.type === "map_type") {
    return { type: { kind: "primitive", name: "any" }, optional: false };
  }
  if (typeNode.type === "qualified_type") {
    // e.g. `time.Time` — a type from another package we don't resolve;
    // `unknown` is the conservative choice (accepts anything on validate)
    // rather than guessing at a shape we can't see.
    return { type: { kind: "primitive", name: "unknown" }, optional: false };
  }

  const t = typeNode.text;
  switch (t) {
    case "string":
      return { type: { kind: "primitive", name: "string" }, optional: false };
    case "int":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
    case "float32":
    case "float64":
      return { type: { kind: "primitive", name: "number" }, optional: false };
    case "bool":
      return { type: { kind: "primitive", name: "boolean" }, optional: false };
    default: {
      const struct = structs.get(t);
      return {
        type: struct ? { kind: "object", fields: struct.fields } : { kind: "reference", name: t },
        optional: false,
      };
    }
  }
}

/** Extracts the `json:"name,omitempty"` tag's field name, or `null` for an
 *  untagged/`json:"-"` field (which Go's own encoding/json would also
 *  exclude from the wire response, so it's correctly excluded from the
 *  inferred schema too). */
function jsonTagName(tagNode: Node | null | undefined, fallback: string): { name: string; omitempty: boolean } | null {
  if (!tagNode) return { name: fallback, omitempty: false };
  const match = tagNode.text.match(/json:"([^"]*)"/);
  if (!match) return { name: fallback, omitempty: false };
  const parts = (match[1] as string).split(",");
  const name = parts[0] as string;
  if (name === "-") return null;
  return { name: name === "" ? fallback : name, omitempty: parts.includes("omitempty") };
}

/** Finds every `type X struct { ... }` and builds a name -> Schema table,
 *  in two passes so structs can embed/reference other structs declared
 *  later in the file. */
function extractStructs(root: Node): Map<string, Schema> {
  const raw: { name: string; fields: Node[] }[] = [];

  for (const node of walk(root)) {
    if (node.type !== "type_declaration") continue;
    for (const spec of node.namedChildren) {
      if (spec.type !== "type_spec") continue;
      const name = spec.childForFieldName("name");
      const typeNode = spec.childForFieldName("type");
      if (!name || !typeNode || typeNode.type !== "struct_type") continue;
      const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list");
      const fields = fieldList ? fieldList.namedChildren.filter((c) => c.type === "field_declaration") : [];
      raw.push({ name: name.text, fields });
    }
  }

  const structs = new Map<string, Schema>();
  for (const s of raw) structs.set(s.name, { kind: "object", name: s.name, fields: {} });
  for (const s of raw) {
    const fields: Record<string, Field> = {};
    for (const fieldDecl of s.fields) {
      const nameNode = fieldDecl.childForFieldName("name");
      const typeNode = fieldDecl.childForFieldName("type");
      const tagNode = fieldDecl.childForFieldName("tag");
      if (!nameNode || !typeNode) continue;
      const tag = jsonTagName(tagNode, nameNode.text);
      if (!tag) continue; // json:"-"
      const { type, optional } = goTypeToFieldType(typeNode, structs);
      fields[tag.name] = { type, optional: optional || tag.omitempty, nullable: optional };
    }
    (structs.get(s.name) as Schema).fields = fields;
  }
  return structs;
}

/** Finds every `name := <expr>.Group("prefix")` declaration and builds a
 *  variable name -> *fully resolved* absolute prefix map, chasing the
 *  chain up through nested groups (`admin := v1.Group("/admin")` where
 *  `v1` itself came from `router.Group("/api/v1")` resolves `admin` to
 *  `/api/v1/admin`, not just `/admin`). A variable not derived from
 *  `.Group(...)` at all (the base `router := gin.Default()`) is treated
 *  as the empty-prefix root once the chain bottoms out on it. */
function extractGroupPrefixes(root: Node): Map<string, string> {
  const raw = new Map<string, { parent: string; prefix: string }>();

  for (const node of walk(root)) {
    if (node.type !== "short_var_declaration") continue;
    const left = node.namedChildren.find((c) => c.type === "expression_list");
    const rightList = node.namedChildren.filter((c) => c.type === "expression_list");
    const right = rightList[1];
    if (!left || !right || left.namedChildCount !== 1) continue;
    const lhsName = left.namedChild(0);
    const call = right.namedChild(0);
    if (!lhsName || lhsName.type !== "identifier" || !call || call.type !== "call_expression") continue;

    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "selector_expression") continue;
    if (fn.childForFieldName("field")?.text !== "Group") continue;
    const parentOperand = fn.childForFieldName("operand");
    const args = call.childForFieldName("arguments");
    const pathArg = args?.namedChildren[0];
    if (!parentOperand || !pathArg || pathArg.type !== "interpreted_string_literal") continue;

    raw.set(lhsName.text, { parent: parentOperand.text, prefix: stringLiteralText(pathArg) });
  }

  const resolved = new Map<string, string>();
  function resolve(name: string, visiting: Set<string>): string {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;
    const entry = raw.get(name);
    if (!entry || visiting.has(name)) return ""; // not a group (base router), or a cycle — no prefix contribution
    visiting.add(name);
    const full = resolve(entry.parent, visiting) + entry.prefix;
    resolved.set(name, full);
    return full;
  }
  for (const name of raw.keys()) resolve(name, new Set());
  return resolved;
}

/** `router.GET("/path", handlerName)` / `router2.POST("/path", handlerName)`
 *  — a call whose selector operand matches `router\d*` (the base engine)
 *  or is a known route-group variable (see `extractGroupPrefixes`), and
 *  whose field is an HTTP method name. Gin's route-registration signature
 *  is `(path, ...middleware, handler)`: any number of middleware
 *  functions may sit between the path and the real handler, which is
 *  always the *last* argument — not necessarily the second. Taking the
 *  second argument unconditionally (as this used to) silently resolved to
 *  a middleware function's name instead of the handler's on the extremely
 *  common `router.GET("/x", authMiddleware, getX)` pattern, producing a
 *  `null` response schema even when the real handler had a perfectly
 *  resolvable one. */
function matchRouteCall(
  call: Node,
  groupPrefixes: Map<string, string>,
): { method: string; routePath: string; handlerName: string; location: Node } | null {
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "selector_expression") return null;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (!operand || !field) return null;
  const prefix = groupPrefixes.get(operand.text);
  if (!ROUTER_RECEIVER_RE.test(operand.text) && prefix === undefined) return null;
  if (!HTTP_METHODS.has(field.text)) return null;

  const args = call.childForFieldName("arguments");
  const namedArgs = args?.namedChildren ?? [];
  const pathArg = namedArgs[0];
  const handlerArg = namedArgs[namedArgs.length - 1];
  if (!pathArg || pathArg.type !== "interpreted_string_literal") return null;
  if (namedArgs.length < 2 || !handlerArg) return null;
  // Handler may be a bare identifier (same-package handler, e.g. `getUser`)
  // or a package-qualified selector expression (e.g. `routes.AddOrder`) —
  // the standard layout once handlers are split into their own package.
  // Anything else (an inline func literal, a method value, etc.) is left
  // unresolved rather than guessed at.
  let handlerName: string;
  if (handlerArg.type === "identifier") {
    handlerName = handlerArg.text;
  } else if (handlerArg.type === "selector_expression") {
    // Use the bare function name (the selector's `field`), not the
    // package-qualified text, so lookups against handlerSchemas (which is
    // keyed by bare function_declaration name, scoped to a single file's
    // tree) stay consistent with the identifier case. In the common case
    // where the handler is defined in a different file/package, this
    // correctly misses and falls back to `null` rather than fabricating a
    // schema — cross-file schema resolution is out of scope for this fix.
    const handlerField = handlerArg.childForFieldName("field");
    if (!handlerField) return null;
    handlerName = handlerField.text;
  } else {
    return null;
  }

  const routePath = (prefix ?? "") + stringLiteralText(pathArg);
  return { method: field.text, routePath, handlerName, location: call };
}

/** For each `func handlerName(c *gin.Context) { ... }`, finds the first
 *  `c.JSON(status, StructName{...})` call in its body and maps the
 *  handler name to that struct's schema (or `null` for an unrecognized
 *  literal shape, e.g. `gin.H{...}` — matching the tool's conservative
 *  "unresolved rather than guessed" stance). */
function extractHandlerResponseSchemas(root: Node, structs: Map<string, Schema>): Map<string, Schema | null> {
  const result = new Map<string, Schema | null>();

  for (const node of walk(root)) {
    if (node.type !== "function_declaration") continue;
    const nameNode = node.childForFieldName("name");
    const params = node.childForFieldName("parameters");
    if (!nameNode || !params) continue;
    if (!/gin\.Context/.test(params.text)) continue; // not a gin handler

    const body = node.childForFieldName("body");
    let schema: Schema | null = null;
    if (body) {
      for (const inner of walk(body)) {
        if (inner.type !== "call_expression") continue;
        const fn = inner.childForFieldName("function");
        if (fn?.type !== "selector_expression") continue;
        if (fn.childForFieldName("field")?.text !== "JSON") continue;

        const args = inner.childForFieldName("arguments");
        const bodyArg = args?.namedChildren[1];
        if (bodyArg?.type === "composite_literal") {
          const typeNode = bodyArg.childForFieldName("type");
          if (typeNode?.type === "type_identifier") {
            schema = structs.get(typeNode.text) ?? null;
          }
        }
        break; // first c.JSON(...) call wins, matching prior behavior
      }
    }
    result.set(nameNode.text, schema);
  }

  return result;
}

export function parseGoServerSourceFromTree(filePath: string, tree: Parser.Tree): ServerHandler[] {
  const root = tree.rootNode;
  const structs = extractStructs(root);
  const handlerSchemas = extractHandlerResponseSchemas(root, structs);
  const groupPrefixes = extractGroupPrefixes(root);
  const handlers: ServerHandler[] = [];

  for (const node of walk(root)) {
    if (node.type !== "call_expression") continue;
    const matched = matchRouteCall(node, groupPrefixes);
    if (!matched) continue;
    handlers.push({
      id: nextId("go-server"),
      method: normalizeMethod(matched.method),
      route: parseRouteTemplate(matched.routePath),
      responseSchema: handlerSchemas.get(matched.handlerName) ?? null,
      framework: "gin",
      location: { file: filePath, ...locationOf(matched.location) },
    });
  }

  return handlers;
}

/** `http.Get("/users/" + id)` / `client.Post(...)` — a call whose selector
 *  operand is `http`/`client` and whose field is an HTTP method name. The
 *  URL argument may be a plain string literal or a `+`-concatenation
 *  chain mixing literals and identifiers; literal segments are joined with
 *  the `__DYN__` placeholder for any identifier segment, matching how
 *  `route-template.ts` treats dynamic path parts. */
function urlArgToTemplate(argNode: Node): { raw: string; dynamic: boolean } {
  if (argNode.type === "interpreted_string_literal" || argNode.type === "raw_string_literal") {
    return { raw: stringLiteralText(argNode), dynamic: false };
  }
  if (argNode.type === "binary_expression") {
    const left = argNode.childForFieldName("left");
    const right = argNode.childForFieldName("right");
    const parts: string[] = [];
    let dynamic = false;
    for (const side of [left, right]) {
      if (!side) continue;
      if (side.type === "interpreted_string_literal" || side.type === "raw_string_literal") {
        parts.push(stringLiteralText(side));
      } else if (side.type === "binary_expression") {
        const nested = urlArgToTemplate(side);
        parts.push(nested.raw);
        dynamic = dynamic || nested.dynamic;
      } else {
        parts.push("__DYN__");
        dynamic = true;
      }
    }
    return { raw: parts.join("") || "__DYN__", dynamic };
  }
  return { raw: "__DYN__", dynamic: true };
}

export function parseGoClientSourceFromTree(filePath: string, tree: Parser.Tree): ClientCallSite[] {
  const root = tree.rootNode;
  const results: ClientCallSite[] = [];

  for (const node of walk(root)) {
    if (node.type !== "call_expression") continue;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "selector_expression") continue;
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (!operand || !field) continue;
    if (!CLIENT_RECEIVERS.has(operand.text) || !HTTP_METHODS.has(field.text.toUpperCase())) continue;

    const args = node.childForFieldName("arguments");
    const urlArg = args?.namedChildren[0];
    if (!urlArg) continue;

    const { raw, dynamic } = urlArgToTemplate(urlArg);
    results.push({
      id: nextId("go-client"),
      method: normalizeMethod(field.text),
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
  const parser = await getParser("go");
  return parser.parse(source);
}

/** Async, in-memory variant of `parseGoServerSourceFromTree` — used by
 *  unit tests so fixtures can live as inline template strings with no
 *  filesystem I/O. `filePath` is cosmetic (used for location reporting). */
export async function parseGoServerSource(filePath: string, source: string): Promise<ServerHandler[]> {
  const parser = await getParser("go");
  return parseGoServerSourceFromTree(filePath, parser.parse(source));
}

/** Async, in-memory variant of `parseGoClientSourceFromTree`. See
 *  `parseGoServerSource` above. */
export async function parseGoClientSource(filePath: string, source: string): Promise<ClientCallSite[]> {
  const parser = await getParser("go");
  return parseGoClientSourceFromTree(filePath, parser.parse(source));
}

export async function parseGoServerHandlers(rootDir: string): Promise<ServerHandler[]> {
  const files = walkFiles(rootDir, GO_EXTENSIONS);
  const results: ServerHandler[] = [];
  for (const file of files) {
    // See the matching try/catch in server-parser.ts's parseTsServerHandlers
    // for why: a single file that fails to parse (missing grammar,
    // malformed source, anything) shouldn't discard every other file's
    // valid results.
    try {
      results.push(...parseGoServerSourceFromTree(file, await parseFile(file)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}

export async function parseGoClientCallSites(rootDir: string): Promise<ClientCallSite[]> {
  const files = walkFiles(rootDir, GO_EXTENSIONS);
  const results: ClientCallSite[] = [];
  for (const file of files) {
    try {
      results.push(...parseGoClientSourceFromTree(file, await parseFile(file)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`driftguard: skipping unparseable file ${file}: ${reason}\n`);
    }
  }
  return results;
}
