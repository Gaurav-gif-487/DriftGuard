import type { PathSegment, RouteTemplate } from "./types.js";

/**
 * Normalizes a raw path string from any supported framework into a
 * framework-agnostic `RouteTemplate`.
 *
 * Recognized dynamic-segment syntaxes:
 *   Express/Fastify/Gin : :id           -> dynamic "id"
 *   Next.js file routes  : [id]         -> dynamic "id"
 *   Next.js catch-all    : [...slug]    -> dynamic "slug"
 *   FastAPI              : {id}         -> dynamic "id"
 *   driftguard internal placeholder : __DYN__ -> dynamic "?"  (used
 *     when a client path was reconstructed from a template literal /
 *     string concatenation and the variable name could not be recovered
 *     token-for-token; see client-parser.ts)
 */
export function parseRouteTemplate(raw: string): RouteTemplate {
  const cleaned = raw.trim();
  const withoutQuery = cleaned.split("?")[0] ?? cleaned;
  const parts = withoutQuery.split("/").filter((p) => p.length > 0);

  const segments: PathSegment[] = parts.map((part) => {
    // Express/Fastify/Gin: :param
    if (part.startsWith(":")) {
      return { kind: "dynamic", name: part.slice(1) };
    }
    // Next.js catch-all: [...slug] or [[...slug]]
    const catchAll = part.match(/^\[{1,2}\.\.\.(\w+)\]{1,2}$/);
    if (catchAll) {
      return { kind: "dynamic", name: catchAll[1] as string };
    }
    // Next.js dynamic: [id]
    const bracket = part.match(/^\[(\w+)\]$/);
    if (bracket) {
      return { kind: "dynamic", name: bracket[1] as string };
    }
    // FastAPI: {id}
    const brace = part.match(/^\{(\w+)\}$/);
    if (brace) {
      return { kind: "dynamic", name: brace[1] as string };
    }
    // Gin also supports *param wildcards.
    if (part.startsWith("*")) {
      return { kind: "dynamic", name: part.slice(1) || "wildcard" };
    }
    // Internal placeholder inserted by client-parser for interpolated
    // segments whose source variable name is unrecoverable.
    if (part === "__DYN__") {
      return { kind: "dynamic", name: "?" };
    }
    return { kind: "static", value: part };
  });

  return { raw: cleaned, segments };
}

/** Renders a route template back to a human-readable canonical string, e.g. `/api/v1/user/:id`. */
export function stringifyRouteTemplate(t: RouteTemplate): string {
  if (t.segments.length === 0) return "/";
  return (
    "/" +
    t.segments
      .map((s) => (s.kind === "static" ? s.value : `:${s.name}`))
      .join("/")
  );
}

/** Two templates match exactly when they have the same segment count and
 *  every static segment is textually identical (dynamic segments match
 *  any dynamic segment regardless of name). */
export function exactRouteMatch(a: RouteTemplate, b: RouteTemplate): boolean {
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i] as PathSegment;
    const sb = b.segments[i] as PathSegment;
    if (sa.kind === "static" && sb.kind === "static") {
      if (sa.value !== sb.value) return false;
    } else if (sa.kind !== sb.kind) {
      // one static, one dynamic at the same position -> not an exact match
      return false;
    }
    // dynamic/dynamic always compatible regardless of param name
  }
  return true;
}
