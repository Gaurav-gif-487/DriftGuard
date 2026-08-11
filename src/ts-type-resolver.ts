import ts from "typescript";
import type { Field, FieldType, Schema } from "./types.js";

/**
 * A "type table" maps a top-level type/interface name declared in a source
 * file to its defining AST node. driftguard resolves types purely
 * syntactically (no TypeChecker / no Program, per the zero-execution,
 * single-file-scan design) — cross-file type references that aren't in the
 * table degrade gracefully to `{kind:"reference", name}` rather than
 * crashing, which is exactly what should happen when a DTO is imported
 * from a package driftguard wasn't pointed at.
 */
export type TypeTable = Map<
  string,
  ts.InterfaceDeclaration | ts.TypeAliasDeclaration
>;

export function buildTypeTable(sourceFile: ts.SourceFile): TypeTable {
  const table: TypeTable = new Map();
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      table.set(stmt.name.text, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      table.set(stmt.name.text, stmt);
    }
  }
  return table;
}

const PRIMITIVE_KEYWORDS: Partial<Record<ts.SyntaxKind, FieldType>> = {
  [ts.SyntaxKind.StringKeyword]: { kind: "primitive", name: "string" },
  [ts.SyntaxKind.NumberKeyword]: { kind: "primitive", name: "number" },
  [ts.SyntaxKind.BooleanKeyword]: { kind: "primitive", name: "boolean" },
  [ts.SyntaxKind.NullKeyword]: { kind: "primitive", name: "null" },
  [ts.SyntaxKind.UndefinedKeyword]: { kind: "primitive", name: "undefined" },
  [ts.SyntaxKind.AnyKeyword]: { kind: "primitive", name: "any" },
  [ts.SyntaxKind.UnknownKeyword]: { kind: "primitive", name: "unknown" },
  [ts.SyntaxKind.VoidKeyword]: { kind: "primitive", name: "undefined" },
};

function isNullKeyword(t: ts.TypeNode): boolean {
  // `null` as a type position is a LiteralTypeNode wrapping a NullKeyword
  // literal, not a bare NullKeyword node — easy to miss since the parallel
  // `void`/`undefined` keywords ARE bare keyword nodes.
  return (
    t.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

function isUndefinedKeyword(t: ts.TypeNode): boolean {
  return (
    t.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.UndefinedKeyword)
  );
}

/** Resolves a name that's missing from the local `TypeTable`, e.g. by
 *  following an import one hop into another file. `typeNodeToFieldType` and
 *  friends only ever call this when the local table misses, and never pass
 *  it along when recursing into whatever it returns — see
 *  `cross-file-resolver.ts` for why that's a deliberate one-hop boundary
 *  rather than a `seen`-guarded traversal of the whole import graph. */
export type ExternalResolver = (
  name: string,
) => { decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration; table: TypeTable } | null;

/** Converts a `ts.TypeNode` into our structural `FieldType`. `seen` guards
 *  against infinite recursion on self-referential / mutually recursive
 *  interfaces (a real hazard once you resolve type references). `resolveExternal`,
 *  if provided, is consulted only when a reference misses the local `table` —
 *  it's how a type imported from a monorepo-sibling shared package gets
 *  resolved instead of degrading straight to a `reference` placeholder. */
export function typeNodeToFieldType(
  node: ts.TypeNode,
  table: TypeTable,
  seen: Set<string> = new Set(),
  resolveExternal?: ExternalResolver,
): FieldType {
  const primitive = PRIMITIVE_KEYWORDS[node.kind];
  if (primitive) return primitive;

  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit)) return { kind: "literal", value: lit.text };
    if (ts.isNumericLiteral(lit))
      return { kind: "literal", value: Number(lit.text) };
    if (lit.kind === ts.SyntaxKind.TrueKeyword)
      return { kind: "literal", value: true };
    if (lit.kind === ts.SyntaxKind.FalseKeyword)
      return { kind: "literal", value: false };
    if (lit.kind === ts.SyntaxKind.NullKeyword)
      return { kind: "primitive", name: "null" };
    return { kind: "primitive", name: "unknown" };
  }

  if (ts.isArrayTypeNode(node)) {
    return {
      kind: "array",
      element: typeNodeToFieldType(node.elementType, table, seen, resolveExternal),
    };
  }

  if (ts.isTupleTypeNode(node)) {
    // Model tuples as arrays of the union of their element types — enough
    // fidelity for contract comparison without a dedicated tuple kind.
    const elementTypes = node.elements.map((e) =>
      ts.isNamedTupleMember(e)
        ? typeNodeToFieldType(e.type, table, seen, resolveExternal)
        : typeNodeToFieldType(e as ts.TypeNode, table, seen, resolveExternal),
    );
    return {
      kind: "array",
      element:
        elementTypes.length === 1
          ? (elementTypes[0] as FieldType)
          : { kind: "union", options: elementTypes },
    };
  }

  if (ts.isTypeLiteralNode(node)) {
    return { kind: "object", fields: typeLiteralToFields(node, table, seen, resolveExternal) };
  }

  if (ts.isUnionTypeNode(node)) {
    const nonNullish = node.types.filter(
      (t) => !isNullKeyword(t) && !isUndefinedKeyword(t),
    );
    const allStringLiterals =
      nonNullish.length > 0 &&
      nonNullish.every(
        (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal),
      );
    if (allStringLiterals) {
      return {
        kind: "enum",
        name: "inline",
        variants: nonNullish.map(
          (t) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text,
        ),
      };
    }
    const options = nonNullish.map((t) =>
      typeNodeToFieldType(t, table, seen, resolveExternal),
    );
    if (options.length === 1) return options[0] as FieldType;
    if (options.length === 0) return { kind: "primitive", name: "null" };
    return { kind: "union", options };
  }

  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeToFieldType(node.type, table, seen, resolveExternal);
  }

  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    // Common ambient generics we can unwrap without needing their declaration.
    if (
      (name === "Array" || name === "ReadonlyArray") &&
      node.typeArguments?.[0]
    ) {
      return {
        kind: "array",
        element: typeNodeToFieldType(node.typeArguments[0], table, seen),
      };
    }
    if (name === "Record" && node.typeArguments?.[1]) {
      // Record<K, V> -> treat as an open object; not enumerable statically.
      return { kind: "reference", name: `Record<...,${node.typeArguments[1].getText()}>` };
    }
    if (name === "Partial" && node.typeArguments?.[0]) {
      const inner = typeNodeToFieldType(node.typeArguments[0], table, seen, resolveExternal);
      if (inner.kind === "object") {
        const fields: Record<string, Field> = {};
        for (const [k, f] of Object.entries(inner.fields)) {
          fields[k] = { ...f, optional: true };
        }
        return { kind: "object", fields };
      }
      return inner;
    }

    if (seen.has(name)) {
      return { kind: "reference", name };
    }

    const local = table.get(name);
    if (local) {
      const nextSeen = new Set(seen).add(name);
      if (ts.isInterfaceDeclaration(local)) {
        return {
          kind: "object",
          fields: interfaceToFields(local, table, nextSeen, resolveExternal),
        };
      }
      return typeNodeToFieldType(local.type, table, nextSeen, resolveExternal);
    }

    // Local table missed. One-level cross-file resolution: if `name` was
    // imported from a relative-path module, follow that single hop. Note
    // `resolveExternal` is deliberately NOT passed through further down —
    // once we've hopped into the shared file, a *second* level of imports
    // there degrades to a `reference` placeholder rather than an unbounded
    // multi-file traversal (see cross-file-resolver.ts).
    const external = resolveExternal?.(name);
    if (external) {
      const nextSeen = new Set(seen).add(name);
      if (ts.isInterfaceDeclaration(external.decl)) {
        return {
          kind: "object",
          fields: interfaceToFields(external.decl, external.table, nextSeen),
        };
      }
      return typeNodeToFieldType(external.decl.type, external.table, nextSeen);
    }

    return { kind: "reference", name };
  }

  if (ts.isIndexedAccessTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return { kind: "primitive", name: "unknown" };
  }

  return { kind: "primitive", name: "unknown" };
}

function propertyToField(
  typeNode: ts.TypeNode | undefined,
  questionToken: ts.QuestionToken | undefined,
  table: TypeTable,
  seen: Set<string>,
  resolveExternal?: ExternalResolver,
): Field {
  if (!typeNode) {
    return {
      type: { kind: "primitive", name: "unknown" },
      optional: Boolean(questionToken),
      nullable: false,
    };
  }

  let nullable = false;
  let optional = Boolean(questionToken);
  let effectiveNode: ts.TypeNode = typeNode;

  if (ts.isUnionTypeNode(typeNode)) {
    const hasNull = typeNode.types.some(isNullKeyword);
    const hasUndefined = typeNode.types.some(isUndefinedKeyword);
    nullable = hasNull;
    optional = optional || hasUndefined;
    const remaining = typeNode.types.filter(
      (t) => !isNullKeyword(t) && !isUndefinedKeyword(t),
    );
    if (remaining.length === 1) {
      effectiveNode = remaining[0] as ts.TypeNode;
    } else if (remaining.length > 1) {
      effectiveNode = ts.factory.updateUnionTypeNode(
        typeNode,
        ts.factory.createNodeArray(remaining),
      );
    } else {
      // union was exactly `null | undefined`
      return {
        type: { kind: "primitive", name: "null" },
        optional,
        nullable,
      };
    }
  }

  return {
    type: typeNodeToFieldType(effectiveNode, table, seen, resolveExternal),
    optional,
    nullable,
  };
}

function typeLiteralToFields(
  node: ts.TypeLiteralNode,
  table: TypeTable,
  seen: Set<string>,
  resolveExternal?: ExternalResolver,
): Record<string, Field> {
  const fields: Record<string, Field> = {};
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const key = member.name.getText();
      fields[key] = propertyToField(member.type, member.questionToken, table, seen, resolveExternal);
    }
  }
  return fields;
}

function interfaceToFields(
  decl: ts.InterfaceDeclaration,
  table: TypeTable,
  seen: Set<string>,
  resolveExternal?: ExternalResolver,
): Record<string, Field> {
  let fields: Record<string, Field> = {};

  // Best-effort `extends` support: merge in base interface fields first so
  // subclass fields can override them, matching TS semantics closely enough
  // for contract comparison purposes.
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      for (const t of clause.types) {
        const baseName = t.expression.getText();
        const base = table.get(baseName);
        if (base && ts.isInterfaceDeclaration(base) && !seen.has(baseName)) {
          fields = {
            ...fields,
            ...interfaceToFields(base, table, new Set(seen).add(baseName), resolveExternal),
          };
        }
      }
    }
  }

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const key = member.name.getText();
      fields[key] = propertyToField(member.type, member.questionToken, table, seen, resolveExternal);
    }
  }
  return fields;
}

/** Resolves a type node to a top-level `Schema`. Returns `null` if the type
 *  clearly isn't shaped like an object payload (e.g. it's just `string`). */
export function typeNodeToSchema(
  node: ts.TypeNode,
  table: TypeTable,
  name?: string,
  resolveExternal?: ExternalResolver,
): Schema | null {
  const ft = typeNodeToFieldType(node, table, undefined, resolveExternal);
  if (ft.kind === "object") {
    return { kind: "object", name, fields: ft.fields };
  }
  return null;
}

/** Builds a best-effort `Schema` from a destructuring binding pattern, e.g.
 *  `const { id, name, address: { city } } = ...`. Every destructured field
 *  is treated as required-and-unknown-typed: the tool doesn't know its type,
 *  but it does know the client's code will break if the field disappears. */
export function bindingPatternToSchema(
  pattern: ts.ObjectBindingPattern,
): Schema {
  const fields: Record<string, Field> = {};
  for (const el of pattern.elements) {
    if (ts.isBindingElement(el) && ts.isIdentifier(el.propertyName ?? el.name)) {
      const key = (el.propertyName ?? el.name).getText();
      if (ts.isObjectBindingPattern(el.name)) {
        fields[key] = {
          type: { kind: "object", fields: bindingPatternToSchema(el.name).fields },
          optional: false,
          nullable: false,
        };
      } else {
        fields[key] = {
          type: { kind: "primitive", name: "unknown" },
          optional: Boolean(el.initializer),
          nullable: false,
        };
      }
    }
  }
  return { kind: "object", fields };
}
