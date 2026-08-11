import test from "node:test";
import assert from "node:assert";
import { typeMatch, validateAll } from "../src/validator.js";
import type { ClientCallSite, Schema, ServerHandler, UnresolvedExplanation } from "../src/types.js";

function obj(fields: Schema["fields"]): Schema {
  return { kind: "object", fields };
}
const str = (opts: Partial<{ optional: boolean; nullable: boolean }> = {}) => ({
  type: { kind: "primitive" as const, name: "string" as const },
  optional: opts.optional ?? false,
  nullable: opts.nullable ?? false,
});
const num = (opts: Partial<{ optional: boolean; nullable: boolean }> = {}) => ({
  type: { kind: "primitive" as const, name: "number" as const },
  optional: opts.optional ?? false,
  nullable: opts.nullable ?? false,
});

test("validator: identical schemas produce zero violations", () => {
  const client = obj({ id: num(), name: str() });
  const server = obj({ id: num(), name: str() });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: server may return MORE fields than the client expects (width subtyping)", () => {
  const client = obj({ id: num() });
  const server = obj({ id: num(), name: str(), extra: str() });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: missing required field is flagged", () => {
  const client = obj({ id: num(), email: str() });
  const server = obj({ id: num() });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "missing-field");
  assert.equal(violations[0]!.path, "email");
  assert.equal(violations[0]!.severity, "error");
});

test("validator: missing OPTIONAL field is not a violation", () => {
  const client = obj({ id: num(), nickname: str({ optional: true }) });
  const server = obj({ id: num() });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: primitive type mutation is flagged (string -> number)", () => {
  const client = obj({ age: str() });
  const server = obj({ age: num() });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "type-mutation");
  assert.equal(violations[0]!.expected, "string");
  assert.equal(violations[0]!.actual, "number");
});

test("validator: nullability introduced on a previously non-nullable field", () => {
  const client = obj({ note: str() });
  const server = obj({ note: str({ nullable: true }) });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "nullability-introduced");
  assert.equal(violations[0]!.severity, "warning");
});

test("validator: optionality introduced on a previously required field", () => {
  const client = obj({ bio: str() });
  const server = obj({ bio: str({ optional: true }) });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "optionality-introduced");
  assert.equal(violations[0]!.severity, "error");
});

test("validator: enum variant removed from the server is NOT flagged (server's remaining variants are still a subset of the client's)", () => {
  const client = obj({
    status: {
      type: { kind: "enum", name: "inline", variants: ["active", "inactive", "banned"] },
      optional: false,
      nullable: false,
    },
  });
  const server = obj({
    status: {
      type: { kind: "enum", name: "inline", variants: ["active", "inactive"] },
      optional: false,
      nullable: false,
    },
  });
  // Directional contract rule is server ⊆ client. {active, inactive} is a
  // subset of {active, inactive, banned}, so every value the server can
  // still emit is one the client already handles — not a breaking change.
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: enum widened to a plain server string is NOT flagged", () => {
  const client = obj({
    status: {
      type: { kind: "enum", name: "inline", variants: ["active", "inactive"] },
      optional: false,
      nullable: false,
    },
  });
  const server = obj({ status: str() });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: nested object schemas are compared recursively with dotted paths", () => {
  const client = obj({ user: { type: { kind: "object", fields: { email: str() } }, optional: false, nullable: false } });
  const server = obj({ user: { type: { kind: "object", fields: {} }, optional: false, nullable: false } });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.path, "user.email");
});

test("validator: array element types are compared", () => {
  const client = obj({
    items: { type: { kind: "array", element: { kind: "primitive", name: "number" } }, optional: false, nullable: false },
  });
  const server = obj({
    items: { type: { kind: "array", element: { kind: "primitive", name: "string" } }, optional: false, nullable: false },
  });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.path, "items[]");
});

test("validator: unresolved cross-file references are treated as unverifiable, not broken", () => {
  const client = obj({
    payload: { type: { kind: "reference", name: "SomeImportedDto" }, optional: false, nullable: false },
  });
  const server = obj({ payload: str() });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: 'any'/'unknown' client fields accept any server shape", () => {
  const client = obj({ meta: { type: { kind: "primitive", name: "any" }, optional: false, nullable: false } });
  const server = obj({ meta: { type: { kind: "object", fields: {} }, optional: false, nullable: false } });
  assert.deepEqual(typeMatch(client, server), []);
});

test("validator: server enum expansion is flagged because server values must be a subset of client values", () => {
  const client = obj({
    status: {
      type: { kind: "enum", name: "inline", variants: ["active", "inactive"] },
      optional: false,
      nullable: false,
    },
  });
  const server = obj({
    status: {
      type: { kind: "enum", name: "inline", variants: ["active", "inactive", "banned"] },
      optional: false,
      nullable: false,
    },
  });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "enum-variant-added");
  assert.match(violations[0]!.message, /banned/);
});

test("validator: literal client contract rejects a widened server primitive", () => {
  const client = obj({
    status: {
      type: { kind: "literal", value: "active" },
      optional: false,
      nullable: false,
    },
  });
  const server = obj({ status: str() });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "type-mutation");
});

test("validator: every branch of a server union must be client-compatible", () => {
  const client = obj({ value: str() });
  const server = obj({
    value: {
      type: {
        kind: "union",
        options: [
          { kind: "primitive", name: "string" },
          { kind: "primitive", name: "number" },
          { kind: "primitive", name: "boolean" },
        ],
      },
      optional: false,
      nullable: false,
    },
  });
  const violations = typeMatch(client, server);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.kind, "type-mutation");
});

// --- validateAll: unresolved-route message enrichment (feature: --explain) ---

function fakeClient(id: string): ClientCallSite {
  return {
    id,
    method: "GET",
    route: { raw: "/api/v1/widgets/:id", segments: [] },
    dynamic: true,
    expectedSchema: null,
    framework: "unknown",
    location: { file: "client.ts", line: 1, column: 1 },
  };
}

function fakeServer(id: string, raw: string): ServerHandler {
  return {
    id,
    method: "GET",
    route: { raw, segments: [] },
    responseSchema: null,
    framework: "express",
    location: { file: "server.ts", line: 1, column: 1 },
  };
}

test("validator: without an explanation, validateAll reproduces the original generic unresolved message exactly (backward compatible)", () => {
  const c = fakeClient("c1");
  const reports = validateAll([], [c]);
  assert.equal(
    reports[0]!.violations[0]!.message,
    "Client call to GET /api/v1/widgets/:id could not be confidently resolved to any server handler.",
  );
});

test("validator: validateAll enriches the unresolved message with a 'below-threshold' closest-candidate explanation when supplied", () => {
  const c = fakeClient("c1");
  const s = fakeServer("s1", "/api/v1/widgets-nearby/:id");
  const explanations: Record<string, UnresolvedExplanation> = {
    c1: { reason: "below-threshold", candidates: [{ server: s, confidence: 0.42 }] },
  };
  const reports = validateAll([], [c], explanations);
  const message = reports[0]!.violations[0]!.message;
  assert.match(message, /closest candidate was \/api\/v1\/widgets-nearby\/:id at confidence 0\.42/);
  assert.match(message, /below the acceptance threshold/);
});

test("validator: validateAll enriches the unresolved message with an 'ambiguous' explanation naming both tied candidates", () => {
  const c = fakeClient("c1");
  const s1 = fakeServer("s1", "/api/v1/widgets/:id");
  const s2 = fakeServer("s2", "/api/v1/widget/:id");
  const explanations: Record<string, UnresolvedExplanation> = {
    c1: {
      reason: "ambiguous",
      candidates: [
        { server: s1, confidence: 0.91 },
        { server: s2, confidence: 0.9 },
      ],
    },
  };
  const reports = validateAll([], [c], explanations);
  const message = reports[0]!.violations[0]!.message;
  assert.match(message, /too close to call/);
  assert.match(message, /\/api\/v1\/widgets\/:id \(0\.91\)/);
  assert.match(message, /\/api\/v1\/widget\/:id \(0\.9\)/);
});
