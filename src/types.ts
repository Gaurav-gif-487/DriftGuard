/**
 * driftguard — shared domain model.
 *
 * Everything in this file is pure data: no parsing, no I/O. Both the
 * client-parser and server-parser compile down to this same `Schema`
 * representation so the validator never has to know which language or
 * framework a field originally came from.
 */

// ---------------------------------------------------------------------------
// Structural type model
// ---------------------------------------------------------------------------

export type PrimitiveName =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "any"
  | "unknown";

export type FieldType =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; element: FieldType }
  | { kind: "object"; fields: Record<string, Field> }
  | { kind: "union"; options: FieldType[] }
  | { kind: "enum"; name: string; variants: string[] }
  /** A named type we saw referenced (e.g. `User`) but could not resolve. */
  | { kind: "reference"; name: string };

export interface Field {
  type: FieldType;
  /** Field may be absent entirely (TS `?:`, Python `Optional[...] = None` with default omission handling is modeled via nullable). */
  optional: boolean;
  /** Field may be present but `null`. */
  nullable: boolean;
}

export interface Schema {
  kind: "object";
  /** Name of the originating type/interface/model, if known. Purely cosmetic. */
  name?: string;
  fields: Record<string, Field>;
}

export function emptySchema(name?: string): Schema {
  return { kind: "object", name, fields: {} };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "UNKNOWN";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** A single path segment of a normalized route template. */
export type PathSegment =
  | { kind: "static"; value: string }
  | { kind: "dynamic"; name: string };

export interface RouteTemplate {
  /** Original path text as written in source, e.g. `/api/v1/user/:id`. */
  raw: string;
  segments: PathSegment[];
}

export type ClientFramework =
  | "axios"
  | "fetch"
  | "react-query"
  | "grpc"
  | "unknown";

export type ServerFramework =
  | "express"
  | "fastify"
  | "nextjs"
  | "fastapi"
  | "gin"
  | "unknown";

export interface ClientCallSite {
  id: string;
  method: HttpMethod;
  route: RouteTemplate;
  /** True when the path was built from string concatenation / template
   *  literals rather than a single string constant. These require the
   *  route matcher's fuzzy resolution path. */
  dynamic: boolean;
  expectedSchema: Schema | null;
  framework: ClientFramework;
  location: SourceLocation;
}

export interface ServerHandler {
  id: string;
  method: HttpMethod;
  route: RouteTemplate;
  responseSchema: Schema | null;
  framework: ServerFramework;
  location: SourceLocation;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export interface RouteMatch {
  client: ClientCallSite;
  server: ServerHandler;
  /** 1.0 for exact static matches, <1.0 for fuzzy-resolved dynamic matches. */
  confidence: number;
  strategy: "exact" | "fuzzy-sequence";
  /** Segment-by-segment evidence for how a fuzzy-sequence match's confidence
   *  was derived. Absent for exact matches, where there's nothing to
   *  explain — the segments matched outright. Optional and additive: any
   *  existing consumer that doesn't read this field is unaffected. */
  explanation?: RouteMatchExplanation;
}

/** One aligned client/server segment pair and its contribution to the
 *  classifier's score, in the same left-to-right order the classifier
 *  walked the path in. */
export interface SegmentEvidence {
  index: number;
  client: string;
  server: string;
  kind: "static-exact" | "static-fuzzy" | "dynamic-compatible" | "unaligned";
  score: number;
}

export interface RouteMatchExplanation {
  segments: SegmentEvidence[];
  /** Per-segment average before the length-agreement penalty. */
  alignmentScore: number;
  /** minLen / maxLen — how much the client/server path depths agree. */
  lengthAgreement: number;
}

/** Why a client call-site could not be resolved to a server handler, and —
 *  when fuzzy matching ran at all — the closest candidate(s) that were
 *  considered and rejected, so an "unresolved" finding in CI is
 *  debuggable instead of a bare fact. */
export interface UnresolvedExplanation {
  reason:
    | "no-dynamic-route" // static client path, no exact server match — fuzzy matching intentionally not attempted
    | "opaque-dynamic-route" // every segment of the client path is a runtime value — nothing to score against
    | "no-same-method-candidates" // no server handler at all shares the HTTP method
    | "multiple-exact-matches" // 2+ server handlers were structurally identical up to param naming
    | "below-threshold" // best fuzzy candidate scored under confidenceThreshold
    | "ambiguous"; // best and second-best fuzzy candidates were too close to call
  /** Best-scoring candidate(s) considered, closest first. Populated only
   *  when fuzzy scoring actually ran (reasons "below-threshold" and
   *  "ambiguous"). */
  candidates?: { server: ServerHandler; confidence: number }[];
}

// ---------------------------------------------------------------------------
// Validation / drift
// ---------------------------------------------------------------------------

// Note: there is deliberately no "enum-variant-removed" kind. The contract
// rule is directional (server ⊆ client, see validator.ts), so a server that
// stops producing a variant the client's type still declares is not a
// violation: every value the server can still emit remains one the client
// already handles. Only the server producing a variant the client does not
// declare ("enum-variant-added") breaks that subset relationship.
export type ViolationKind =
  | "missing-field"
  | "type-mutation"
  | "enum-variant-added"
  | "nullability-introduced"
  | "optionality-introduced"
  | "unresolved-route";

export type Severity = "error" | "warning" | "note";

export interface Violation {
  kind: ViolationKind;
  severity: Severity;
  /** Dot-path into the schema, e.g. `data.user.email`. */
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface DriftReport {
  match: RouteMatch | null;
  /** Present when route resolution itself failed. */
  unresolvedClient?: ClientCallSite;
  /** The structured reason route resolution failed, mirrored alongside the
   *  human-readable message already embedded in `violations[].message`.
   *  Kept as its own field (not just parsed back out of that string) so a
   *  report-level diagnostic — e.g. "100% of client calls failed to match
   *  for the exact same structural reason, which usually means --server
   *  doesn't cover the file(s) that mount a shared prefix, not that every
   *  endpoint is independently missing" — can check the actual reason code
   *  rather than pattern-matching prose that's free to reword over time. */
  unresolvedReason?: UnresolvedExplanation;
  violations: Violation[];
}
