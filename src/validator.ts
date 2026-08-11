import type {
  ClientCallSite,
  DriftReport,
  Field,
  FieldType,
  PrimitiveName,
  RouteMatch,
  Schema,
  UnresolvedExplanation,
  Violation,
} from "./types.js";

/**
 * Structural subtyping engine.
 *
 * driftguard's compatibility rule is:
 *
 *     TypeMatch(T_client, T_server)  <=>  T_server ⊆ T_client
 *
 * Read right-to-left: every value the server can actually produce
 * (T_server) must be assignable to what the client declared it expects
 * (T_client). That's ordinary structural/width subtyping — the server is
 * free to return *more* than the client asked for (extra fields are not a
 * violation), but it may never return *less*, and it may never silently
 * change the shape of a field the client depends on.
 *
 * "Unverifiable" is treated as distinct from "broken": when either side's
 * type couldn't be statically resolved (an unresolved cross-file
 * `reference`, `any`, `unknown`), the validator does not create a
 * violation — false positives erode trust in a CI gate far faster than an
 * occasional missed true positive.
 */

function widenPrimitive(t: FieldType): PrimitiveName | null {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "literal":
      return typeof t.value === "string"
        ? "string"
        : typeof t.value === "number"
        ? "number"
        : "boolean";
    case "enum":
      return "string";
    default:
      return null;
  }
}

function isUnverifiable(t: FieldType): boolean {
  return (
    t.kind === "reference" ||
    (t.kind === "primitive" && (t.name === "any" || t.name === "unknown"))
  );
}

function typeLabel(t: FieldType): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "literal":
      return JSON.stringify(t.value);
    case "array":
      return `${typeLabel(t.element)}[]`;
    case "object":
      return `{ ${Object.keys(t.fields).join(", ")} }`;
    case "union":
      return t.options.map(typeLabel).join(" | ");
    case "enum":
      return `enum(${t.variants.join(" | ")})`;
    case "reference":
      return t.name;
  }
}

function compareFieldType(
  clientType: FieldType,
  serverType: FieldType,
  path: string,
  violations: Violation[],
): void {
  if (isUnverifiable(clientType) || isUnverifiable(serverType)) {
    return;
  }

  if (clientType.kind === "object") {
    if (serverType.kind !== "object") {
      violations.push({
        kind: "type-mutation",
        severity: "error",
        path,
        message: `Client expects an object at '${path}' but server now returns ${typeLabel(serverType)}.`,
        expected: typeLabel(clientType),
        actual: typeLabel(serverType),
      });
      return;
    }
    compareSchemaFields(clientType.fields, serverType.fields, path, violations);
    return;
  }

  if (clientType.kind === "array") {
    if (serverType.kind !== "array") {
      violations.push({
        kind: "type-mutation",
        severity: "error",
        path,
        message: `Client expects an array at '${path}' but server now returns ${typeLabel(serverType)}.`,
        expected: typeLabel(clientType),
        actual: typeLabel(serverType),
      });
      return;
    }
    compareFieldType(clientType.element, serverType.element, `${path}[]`, violations);
    return;
  }

  if (clientType.kind === "enum") {
    if (serverType.kind === "enum") {
      // Subtyping is directional: the server's set of possible values must
      // be a subset of the client's accepted values. The old implementation
      // accidentally checked the inverse (client \ server), so it missed
      // newly introduced server variants.
      const added = serverType.variants.filter((v) => !clientType.variants.includes(v));
      for (const variant of added) {
        violations.push({
          kind: "enum-variant-added",
          severity: "error",
          path,
          message: `Server may now return enum variant '${variant}' at '${path}', which the client contract does not declare.`,
          expected: typeLabel(clientType),
          actual: typeLabel(serverType),
        });
      }
      return;
    }
    if (serverType.kind === "literal") {
      if (typeof serverType.value === "string" && clientType.variants.includes(serverType.value)) {
        return;
      }
      violations.push({
        kind: "type-mutation",
        severity: "error",
        path,
        message: `Server now returns ${typeLabel(serverType)} at '${path}', outside the client's enum.`,
        expected: typeLabel(clientType),
        actual: typeLabel(serverType),
      });
      return;
    }
    // Server type widened past the enum (e.g. now a bare string) — retain the
    // project's documented compatibility policy: widening to string is not
    // reported as a breaking change because all prior enum values remain
    // representable. This is deliberately less strict than set inclusion.
    if (widenPrimitive(serverType) === "string") return;
  }

  if (clientType.kind === "literal") {
    if (serverType.kind === "literal" && Object.is(clientType.value, serverType.value)) {
      return;
    }
    // A literal client contract is narrower than its primitive. Returning
    // `string` where the client expected exactly `"active"` is therefore a
    // real contract expansion and can break code that relies on the literal.
    violations.push({
      kind: "type-mutation",
      severity: "error",
      path,
      message: `Server type at '${path}' is not compatible with the client's literal ${typeLabel(clientType)}.`,
      expected: typeLabel(clientType),
      actual: typeLabel(serverType),
    });
    return;
  }

  if (clientType.kind === "union") {
    const compatible = clientType.options.some((opt) => {
      const probe: Violation[] = [];
      compareFieldType(opt, serverType, path, probe);
      return probe.length === 0;
    });
    if (!compatible) {
      violations.push({
        kind: "type-mutation",
        severity: "error",
        path,
        message: `Server type at '${path}' is not compatible with any member of the client's expected union.`,
        expected: typeLabel(clientType),
        actual: typeLabel(serverType),
      });
    }
    return;
  }

  if (serverType.kind === "union") {
    // Every value the server may return must be accepted by the client.
    // Checking only the first incompatible option could miss a later branch.
    const incompatibleOptions = serverType.options.filter((opt) => {
      const probe: Violation[] = [];
      compareFieldType(clientType, opt, path, probe);
      return probe.length > 0;
    });
    if (incompatibleOptions.length > 0) {
      violations.push({
        kind: "type-mutation",
        severity: "error",
        path,
        message: `Server may return ${incompatibleOptions.map(typeLabel).join(" or ")} at '${path}', which is incompatible with the client's expected ${typeLabel(clientType)}.`,
        expected: typeLabel(clientType),
        actual: typeLabel(serverType),
      });
    }
    return;
  }

  const clientPrim = widenPrimitive(clientType);
  const serverPrim = widenPrimitive(serverType);
  if (clientPrim && serverPrim && clientPrim !== serverPrim) {
    // null <-> undefined is a nullability concern, handled separately at
    // the field level; don't double-report it as a type mutation here.
    if (
      (clientPrim === "null" && serverPrim === "undefined") ||
      (clientPrim === "undefined" && serverPrim === "null")
    ) {
      return;
    }
    violations.push({
      kind: "type-mutation",
      severity: "error",
      path,
      message: `Field '${path}' changed type from '${clientPrim}' to '${serverPrim}'.`,
      expected: clientPrim,
      actual: serverPrim,
    });
  }
}

function compareField(clientField: Field, serverField: Field, path: string, violations: Violation[]): void {
  if (serverField.nullable && !clientField.nullable) {
    violations.push({
      kind: "nullability-introduced",
      severity: "warning",
      path,
      message: `Server may now return 'null' for '${path}', which the client's contract does not account for.`,
    });
  }
  if (serverField.optional && !clientField.optional) {
    violations.push({
      kind: "optionality-introduced",
      severity: "error",
      path,
      message: `Server may now omit '${path}' entirely, but the client treats it as required.`,
    });
  }
  compareFieldType(clientField.type, serverField.type, path, violations);
}

function compareSchemaFields(
  clientFields: Record<string, Field>,
  serverFields: Record<string, Field>,
  basePath: string,
  violations: Violation[],
): void {
  for (const [key, clientField] of Object.entries(clientFields)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const serverField = serverFields[key];
    if (!serverField) {
      if (!clientField.optional) {
        violations.push({
          kind: "missing-field",
          severity: "error",
          path,
          message: `Required field '${path}' is missing from the server response.`,
          expected: typeLabel(clientField.type),
        });
      }
      continue;
    }
    compareField(clientField, serverField, path, violations);
  }
}

/** Verifies `TypeMatch(client, server)`, returning the list of breaking
 *  changes (empty = fully compatible). */
export function typeMatch(client: Schema, server: Schema): Violation[] {
  const violations: Violation[] = [];
  compareSchemaFields(client.fields, server.fields, "", violations);
  return violations;
}

/** Validates a single resolved route match, producing a `DriftReport`. */
export function validateMatch(match: RouteMatch): DriftReport {
  const { client, server } = match;
  if (!client.expectedSchema || !server.responseSchema) {
    // Nothing to structurally compare — not a breaking change by
    // definition, just unverifiable. The CLI surfaces this at "note"
    // severity so teams can see coverage gaps without failing the build.
    return { match, violations: [] };
  }
  return { match, violations: typeMatch(client.expectedSchema, server.responseSchema) };
}

/** Renders the closest-candidate / reason detail for an unresolved route
 *  onto the base "could not be resolved" message, so a CI note is
 *  debuggable instead of a bare fact. Falls back to the original generic
 *  message when no explanation was supplied (keeps this backward
 *  compatible with any caller that doesn't have one). */
function unresolvedMessage(client: ClientCallSite, explanation?: UnresolvedExplanation): string {
  const base = `Client call to ${client.method} ${client.route.raw} could not be confidently resolved to any server handler`;
  if (!explanation) return `${base}.`;

  switch (explanation.reason) {
    case "no-same-method-candidates":
      return `${base}: no server handler exists for ${client.method} at all.`;
    case "no-dynamic-route":
      return `${base}: the client path is static and no exact server match exists (fuzzy matching is only attempted for dynamically-built paths, to avoid guesses like '/users' ~ '/user-settings').`;
    case "opaque-dynamic-route":
      return `${base}: every segment of the client path is a runtime value, so there is no literal path evidence to match against (typically a base URL or full URL held in a variable).`;
    case "multiple-exact-matches": {
      const routes = (explanation.candidates ?? []).map((c) => c.server.route.raw).join(", ");
      return `${base}: ambiguous between ${explanation.candidates?.length ?? 0} structurally identical server handlers (${routes}).`;
    }
    case "below-threshold": {
      const [top] = explanation.candidates ?? [];
      return top
        ? `${base}: closest candidate was ${top.server.route.raw} at confidence ${top.confidence}, below the acceptance threshold.`
        : `${base}.`;
    }
    case "ambiguous": {
      const [top, second] = explanation.candidates ?? [];
      return top && second
        ? `${base}: top two candidates were too close to call — ${top.server.route.raw} (${top.confidence}) vs ${second.server.route.raw} (${second.confidence}).`
        : `${base}.`;
    }
  }
}

/** Validates every resolved match and reports unresolved client call-sites
 *  as their own drift-relevant finding. `unresolvedExplanations` is
 *  optional and additive — omitting it reproduces the prior generic
 *  message exactly. */
export function validateAll(
  matches: RouteMatch[],
  unresolvedClients: ClientCallSite[],
  unresolvedExplanations: Record<string, UnresolvedExplanation> = {},
): DriftReport[] {
  const reports = matches.map(validateMatch);
  for (const client of unresolvedClients) {
    reports.push({
      match: null,
      unresolvedClient: client,
      unresolvedReason: unresolvedExplanations[client.id],
      violations: [
        {
          kind: "unresolved-route",
          severity: "note",
          path: "",
          message: unresolvedMessage(client, unresolvedExplanations[client.id]),
        },
      ],
    });
  }
  return reports;
}

export type { Violation } from "./types.js";
