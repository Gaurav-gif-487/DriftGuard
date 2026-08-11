import ts from "typescript";
import type { Field, FieldType, Schema } from "./types.js";

/**
 * Server handlers usually don't return a typed generic the way client
 * call-sites do — they return an object *literal* (`res.json({ id, name })`).
 * This module infers a structural schema directly from that literal's AST
 * shape, which is what actually goes over the wire, independent of whatever
 * TypeScript type (if any) the surrounding code claims.
 */
export function objectExpressionToFieldType(expr: ts.Expression): FieldType {
  if (ts.isObjectLiteralExpression(expr)) {
    const fields: Record<string, Field> = {};
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop) && isNameable(prop.name)) {
        const key = nameText(prop.name);
        fields[key] = valueToField(prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        fields[prop.name.text] = {
          type: { kind: "primitive", name: "unknown" },
          optional: false,
          nullable: false,
        };
      }
      // Spread assignments (`...rest`) are intentionally not expanded: we
      // don't do cross-scope data-flow analysis, so a spread of an unknown
      // source is treated as "this object may have additional unmodeled
      // fields," which the validator already tolerates by design.
    }
    return { kind: "object", fields };
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const first = expr.elements[0];
    return {
      kind: "array",
      element: first ? valueToField(first).type : { kind: "primitive", name: "unknown" },
    };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "primitive", name: "string" };
  }
  if (ts.isNumericLiteral(expr)) return { kind: "primitive", name: "number" };
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "primitive", name: "boolean" };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "primitive", name: "null" };
  }
  if (ts.isParenthesizedExpression(expr)) {
    return objectExpressionToFieldType(expr.expression);
  }
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return objectExpressionToFieldType(expr.expression);
  }
  if (ts.isIdentifier(expr)) {
    return { kind: "reference", name: expr.text };
  }
  if (ts.isCallExpression(expr)) {
    return { kind: "reference", name: expr.expression.getText() + "()" };
  }
  return { kind: "primitive", name: "unknown" };
}

function valueToField(expr: ts.Expression): Field {
  return { type: objectExpressionToFieldType(expr), optional: false, nullable: false };
}

function isNameable(
  name: ts.PropertyName,
): name is ts.Identifier | ts.StringLiteral | ts.NumericLiteral {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name);
}
function nameText(name: ts.Identifier | ts.StringLiteral | ts.NumericLiteral): string {
  return name.text;
}

export function objectExpressionToSchema(expr: ts.Expression): Schema | null {
  const ft = objectExpressionToFieldType(expr);
  return ft.kind === "object" ? { kind: "object", fields: ft.fields } : null;
}
